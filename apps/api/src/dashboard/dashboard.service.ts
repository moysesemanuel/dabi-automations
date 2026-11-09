import { Injectable } from "@nestjs/common";
import { deriveEventView, eventReasonFromNote } from "@dabi/contracts";
import { PrismaService } from "../prisma/prisma.module";

export type HistoryKind = "dm" | "public";
export interface HistoryQuery { status?: string; automationId?: string; page?: number; pageSize?: number }

const STATUSES = ["PENDING", "HELD", "SENT", "FAILED", "UNKNOWN", "CANCELED"] as const;
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
    const [accounts, media, active, paused, dm, pub, needsReconnect, needsReview] = await Promise.all([
      this.prisma.socialAccount.count({ where }),
      this.prisma.media.count({ where }),
      this.prisma.automation.count({ where: { ...where, status: "ACTIVE" } }),
      this.prisma.automation.count({ where: { ...where, status: "PAUSED" } }),
      this.prisma.messageDelivery.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.publicReply.groupBy({ by: ["status"], where, _count: { _all: true } }),
      this.prisma.socialCredential.count({ where: { status: "NEEDS_RECONNECT", socialAccount: { organizationId } } }),
      this.prisma.automationEvent.count({ where: { ...where, status: "RECEIVED" as const, error: { startsWith: "needs_review." } } }),
    ]);
    const tally = (g: { status: string; _count: { _all: number } }[]) =>
      Object.fromEntries(STATUSES.map((s) => [s, g.find((x) => x.status === s)?._count._all ?? 0]));
    return { accounts, needsReconnect, needsReview, media, automations: { active, paused }, directMessages: tally(dm), publicReplies: tally(pub) };
  }

  /**
   * Eventos que REQUEREM ANÁLISE (`needs_review.*`): nada foi enviado e o evento ficou parado para investigação.
   * Só eventos atribuíveis à organização aparecem aqui; os sem organização (ex.: conta não identificada) ficam só no log do worker.
   * Devolve IDs internos e textos FIXOS do catálogo: nunca o texto do comentário, autor, tokens nem IDs da Meta.
   */
  async attention(organizationId: string, limit = 20) {
    const take = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
    const where = { organizationId, status: "RECEIVED" as const, error: { startsWith: "needs_review." } };
    const [total, rows] = await Promise.all([
      this.prisma.automationEvent.count({ where }),
      // `payload` é lido SÓ para achar o ID do comentário e consultar as entregas; nunca é devolvido.
      this.prisma.automationEvent.findMany({ where, orderBy: { receivedAt: "desc" }, take, select: { id: true, receivedAt: true, status: true, error: true, payload: true } }),
    ]);
    const commentOf = (e: { payload: any }) => String(e.payload?.value?.comment_id ?? e.payload?.value?.id ?? "");
    const commentIds = rows.map(commentOf).filter(Boolean);
    // O registro de entrega é criado ANTES de qualquer chamada à Meta: sem MessageDelivery nem PublicReply para o comentário,
    // há GARANTIA de que o DaBiChat não chamou a Meta. Só então o texto pode dizer que nada foi enviado.
    const [dms, pubs] = commentIds.length
      ? await Promise.all([
          this.prisma.messageDelivery.findMany({ where: { organizationId, commentId: { in: commentIds } }, select: { commentId: true, status: true } }),
          this.prisma.publicReply.findMany({ where: { organizationId, commentId: { in: commentIds } }, select: { commentId: true, status: true } }),
        ])
      : [[], []];
    const dmBy = new Map<string, any>(dms.map((d: any) => [d.commentId, d])); const pubBy = new Map<string, any>(pubs.map((d: any) => [d.commentId, d]));
    return {
      total,
      items: rows.map((e: { id: string; receivedAt: Date; status: string; error: string | null; payload: any }) => {
        const cid = commentOf(e);
        const dm = cid ? dmBy.get(cid) ?? null : null; const pub = cid ? pubBy.get(cid) ?? null : null;
        // Sem ID de comentário identificável não há como provar a ausência de entrega: nunca afirma.
        const v = deriveEventView(e, dm, pub, { noDeliveryRecords: Boolean(cid) && !dm && !pub });
        return { id: e.id, receivedAt: e.receivedAt, state: v.state, severity: v.severity, headline: v.headline, detail: v.detail, reason: eventReasonFromNote(e.error) };
      }),
    };
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
