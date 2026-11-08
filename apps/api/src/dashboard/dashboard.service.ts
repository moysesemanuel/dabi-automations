import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.module";

export type HistoryKind = "dm" | "public";
export interface HistoryQuery { status?: string; automationId?: string; page?: number; pageSize?: number }

const STATUSES = ["PENDING", "HELD", "SENT", "FAILED", "UNKNOWN"] as const;
const MAX_PAGE_SIZE = 50;

/** Só campos seguros para o navegador: nunca token, IV, tag nem ids de destinatário. */
const safeProviderInfo = (r: any) => {
  if (!r || typeof r !== "object") return null;
  const { code, error_subcode, fbtrace_id, http, rateLimited, id, message_id } = r as Record<string, unknown>;
  return { code, error_subcode, fbtrace_id, http, rateLimited, replyId: id, messageId: message_id };
};

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  /** Contas conectadas e o estado da credencial (sem nenhum dado do token). */
  async accounts(organizationId: string) {
    const rows = await this.prisma.socialAccount.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, username: true, providerAccountId: true, createdAt: true, webhookStatus: true, webhookSubscribedAt: true, webhookError: true,
        credential: { select: { loginMode: true, expiresAt: true, scopes: true, updatedAt: true, status: true, statusReason: true, statusChangedAt: true } },
        _count: { select: { media: true, automations: true } },
      },
    });
    return rows.map(({ credential, _count, ...a }) => ({
      ...a,
      mediaCount: _count.media,
      automationCount: _count.automations,
      credential: credential
        ? { connected: true, loginMode: credential.loginMode, expiresAt: credential.expiresAt, scopes: credential.scopes, updatedAt: credential.updatedAt, status: credential.status, statusReason: credential.statusReason, statusChangedAt: credential.statusChangedAt }
        : { connected: false },
    }));
  }

  /** Números da visão geral, sempre restritos à organização. */
  async overview(organizationId: string) {
    const where = { organizationId };
    const [accounts, media, active, paused, dm, pub, needsReconnect] = await Promise.all([
      this.prisma.socialAccount.count({ where }),
      this.prisma.media.count({ where }),
      this.prisma.automation.count({ where: { ...where, status: "ACTIVE" } }),
      this.prisma.automation.count({ where: { ...where, status: "PAUSED" } }),
      this.prisma.messageDelivery.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.publicReply.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.socialCredential.count({ where: { status: "NEEDS_RECONNECT", socialAccount: { organizationId } } }),
    ]);
    const tally = (g: { status: string; _count: { _all: number } }[]) =>
      Object.fromEntries(STATUSES.map((s) => [s, g.find((x) => x.status === s)?._count._all ?? 0]));
    return { accounts, needsReconnect, media, automations: { active, paused }, directMessages: tally(dm), publicReplies: tally(pub) };
  }

  /** Histórico paginado de DMs (kind=dm) ou respostas públicas (kind=public). */
  async history(organizationId: string, kind: HistoryKind, q: HistoryQuery) {
    const page = Math.max(1, Math.floor(q.page ?? 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(q.pageSize ?? 20)));
    const where: Record<string, unknown> = { organizationId };
    if (q.status && (STATUSES as readonly string[]).includes(q.status)) where.status = q.status;
    // Filtro por automação sempre combinado com a organização: id de outra org não retorna nada.
    if (q.automationId) where.automationId = q.automationId;

    const model: any = kind === "dm" ? this.prisma.messageDelivery : this.prisma.publicReply;
    const [total, rows] = await Promise.all([
      model.count({ where }),
      model.findMany({
        where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize,
        select: {
          id: true, commentId: true, status: true, attempts: true, error: true, providerResponse: true, createdAt: true, updatedAt: true,
          automation: { select: { id: true, keyword: true, media: { select: { permalink: true } } } },
        },
      }),
    ]);
    return {
      page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((r: any) => ({
        id: r.id, commentId: r.commentId, status: r.status, attempts: r.attempts, error: r.error,
        provider: safeProviderInfo(r.providerResponse),
        createdAt: r.createdAt, updatedAt: r.updatedAt,
        automation: { id: r.automation.id, keyword: r.automation.keyword, permalink: r.automation.media?.permalink ?? null },
      })),
    };
  }
}
