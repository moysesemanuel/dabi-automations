import { Injectable, NotFoundException } from "@nestjs/common";
import { decryptToken, loadEnv } from "@dabi/config";
import { PrismaService } from "../prisma/prisma.module";
import { AuditService } from "../audit/audit.service";
import { graphGetJson, graphHost, type LoginMode } from "../instagram/graph";

const MAX_PAGES = 4; // até ~200 publicações por sincronização
const FIELDS = "id,caption,media_type,permalink,timestamp";

@Injectable()
export class MediaService {
  /** Só para testes; o Nest não injeta isto. */
  fetchImpl?: typeof fetch;
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  /** Busca as publicações na Meta usando a credencial salva e grava em Media (upsert). */
  async sync(organizationId: string, accountId: string, userId?: string) {
    // Filtra por organizationId: conta de outra organização => 404 (não revela que existe).
    const account = await this.prisma.socialAccount.findFirst({
      where: { id: accountId, organizationId },
      include: { credential: true },
    });
    if (!account || !account.credential) throw new NotFoundException("Conta não encontrada ou sem credencial.");

    const env = loadEnv();
    const c = account.credential;
    const token = decryptToken({ encrypted: c.encryptedToken, iv: c.tokenIv, tag: c.tokenTag }, env.TOKEN_ENCRYPTION_KEY);
    const mode = c.loginMode as LoginMode;
    const owner = mode === "FACEBOOK" ? account.providerAccountId : "me";
    let url: string | undefined =
      `${graphHost(mode)}/${env.META_GRAPH_VERSION}/${owner}/media?fields=${FIELDS}&limit=50&access_token=${encodeURIComponent(token)}`;

    let synced = 0;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await graphGetJson(url, token, this.fetchImpl);
      for (const m of body.data ?? []) {
        await this.prisma.media.upsert({
          where: { socialAccountId_providerMediaId: { socialAccountId: account.id, providerMediaId: String(m.id) } },
          create: {
            organizationId, socialAccountId: account.id, providerMediaId: String(m.id),
            permalink: m.permalink ?? null, caption: m.caption ?? null, mediaType: m.media_type ?? null,
          },
          update: { permalink: m.permalink ?? null, caption: m.caption ?? null, mediaType: m.media_type ?? null },
        });
        synced++;
      }
      url = body.paging?.next; // a URL "next" já carrega o token; nunca é logada
    }
    await this.audit.log({ action: "media.sync", organizationId, userId, entityType: "SocialAccount", entityId: account.id, metadata: { synced } });
    return { synced };
  }

  list(organizationId: string, socialAccountId?: string) {
    return this.prisma.media.findMany({
      where: { organizationId, ...(socialAccountId ? { socialAccountId } : {}) },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, socialAccountId: true, providerMediaId: true, permalink: true, caption: true, mediaType: true },
    });
  }
}
