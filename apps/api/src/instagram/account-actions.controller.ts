import { ConflictException, Controller, ForbiddenException, HttpCode, Injectable, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { loadEnv } from "@dabi/config";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { PrismaService } from "../prisma/prisma.module";
import { InstagramOAuthService } from "./instagram-oauth.controller";
import { SubscriptionError, subscribeAccountWebhook } from "./webhook-subscription";

@Injectable()
export class AccountActionsService {
  constructor(private prisma: PrismaService, private oauth: InstagramOAuthService) {}

  /** Inicia a reconexão de UMA conta existente desta organização (nunca substitui token automaticamente). */
  reconnect(organizationId: string, accountId: string, userId: string) { return this.oauth.start(userId, organizationId, accountId); }

  async subscribeWebhook(organizationId: string, accountId: string, actorUserId: string) {
    const e = loadEnv();
    try {
      return await subscribeAccountWebhook(
        { prisma: this.prisma, env: { tokenEncryptionKey: e.TOKEN_ENCRYPTION_KEY, graphVersion: e.META_GRAPH_VERSION, allowedAccounts: e.INSTAGRAM_WEBHOOK_SUBSCRIBE_ACCOUNTS } },
        { organizationId, accountId, actorUserId },
      );
    } catch (err) {
      if (err instanceof SubscriptionError) {
        if (err.code === "not_found") throw new NotFoundException(err.message);
        if (err.code === "disabled") throw new ForbiddenException(err.message);
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }
}

/** Ações por conta (só OWNER/ADMIN). A organização vem do caminho validado pelo OrgGuard. */
@Controller("orgs/:orgId/accounts/:accountId")
@UseGuards(JwtAuthGuard, OrgGuard)
@Roles("OWNER", "ADMIN")
export class AccountActionsController {
  constructor(private svc: AccountActionsService) {}

  /** Ativa o recebimento de comentários (assina o webhook desta conta). Ação explícita; nunca automática. */
  @Post("webhook-subscription") @HttpCode(200)
  subscribe(@Param("orgId") orgId: string, @Param("accountId") accountId: string, @Req() req: any) {
    return this.svc.subscribeWebhook(orgId, accountId, req.user.id);
  }

  /** Devolve a URL de autorização da Meta para reconectar esta conta (token revogado ou inválido). */
  @Post("reconnect") @HttpCode(200)
  reconnect(@Param("orgId") orgId: string, @Param("accountId") accountId: string, @Req() req: any) {
    return this.svc.reconnect(orgId, accountId, req.user.id);
  }
}
