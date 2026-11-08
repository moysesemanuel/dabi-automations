import { Body, Controller, ForbiddenException, HttpCode, Injectable, Logger, Param, Post, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { Redis } from "ioredis";
import { loadEnv } from "@dabi/config";
import { completeInstagramOAuthSchema, type CompleteInstagramOAuthDto } from "@dabi/contracts";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ZodPipe } from "../auth/zod.pipe";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { ConnectionOnboardingService } from "../onboarding/connection-onboarding.service";
import { PrismaService } from "../prisma/prisma.module";
import { OAuthError, metaUnifiedLogin, resolveRedirectUri, type ConnectionProvider, type OAuthDeps, type OAuthStateStore, type StatePayload } from "./oauth";

/** State no Redis: SET com expiração e GETDEL (atômico) para uso único. Se o Redis cair, o fluxo não começa. */
class RedisOAuthStateStore implements OAuthStateStore {
  private _redis?: Redis;
  private get redis() {
    return (this._redis ??= new Redis(loadEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000 }));
  }
  private async ready() { if (this.redis.status === "wait") await this.redis.connect(); }
  async put(key: string, payload: StatePayload, ttl: number) { await this.ready(); await this.redis.set(key, JSON.stringify(payload), "EX", ttl); }
  async take(key: string) {
    await this.ready();
    const raw = await this.redis.getdel(key);
    return raw ? (JSON.parse(raw) as StatePayload) : null;
  }
}

@Injectable()
export class InstagramOAuthService {
  private log = new Logger("InstagramOAuth");
  private store: OAuthStateStore = new RedisOAuthStateStore();
  /** Provedor ativo. Hoje fixo no Unified Login. */
  private provider: ConnectionProvider = metaUnifiedLogin;
  constructor(private prisma: PrismaService, private onboarding: ConnectionOnboardingService) {}

  private deps(): OAuthDeps {
    const e = loadEnv();
    return {
      prisma: this.prisma,
      store: this.store,
      env: { appId: e.META_APP_ID, appSecret: e.META_APP_SECRET, configId: e.META_LOGIN_CONFIG_ID, redirectUri: resolveRedirectUri(e.WEB_URL, e.INSTAGRAM_OAUTH_REDIRECT_URI), graphVersion: e.META_GRAPH_VERSION, tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY },
    };
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      if (e instanceof OAuthError) {
        if (e.code === "forbidden") throw new ForbiddenException(e.message);
        throw new ServiceUnavailableException(e.message);
      }
      throw e;
    }
  }

  start(userId: string, organizationId: string) {
    return this.guard(async () => {
      const r = await this.provider.start(this.deps(), { userId, organizationId });
      await this.onboarding.markConnecting(organizationId, userId);
      return r;
    });
  }

  complete(userId: string, dto: CompleteInstagramOAuthDto) {
    return this.guard(async () => {
      const r = await this.provider.complete(this.deps(), { userId, ...dto });
      // Só o resultado, nunca code/token/secret.
      if (r.organizationId) await this.onboarding.recordOutcome(r.organizationId, userId, r.outcome);
      this.log.log(`oauth: ${r.outcome} (conectadas=${r.connected.length}, ignoradas=${r.skipped.length})`);
      return r;
    });
  }
}

@Controller()
export class InstagramOAuthController {
  constructor(private oauth: InstagramOAuthService) {}

  /** Devolve a URL de autorização da Meta. Só OWNER/ADMIN da organização. */
  @Post("orgs/:orgId/instagram/connect") @HttpCode(200) @UseGuards(JwtAuthGuard, OrgGuard) @Roles("OWNER", "ADMIN")
  start(@Param("orgId") orgId: string, @Req() req: any) { return this.oauth.start(req.user.id, orgId); }

  /** Chamada pelo callback do web com o code/state que a Meta devolveu. A organização vem do state, não do corpo. */
  @Post("instagram/oauth/complete") @HttpCode(200) @UseGuards(JwtAuthGuard)
  complete(@Req() req: any, @Body(new ZodPipe(completeInstagramOAuthSchema)) dto: CompleteInstagramOAuthDto) { return this.oauth.complete(req.user.id, dto); }
}
