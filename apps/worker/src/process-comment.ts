import { commentEventJobSchema, normalizeKeyword, type CommentEventJob } from "@dabi/contracts";
import { decryptToken } from "@dabi/config";

/** Resposta privada só é aceita pela Meta até 7 dias após o comentário. */
export const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface Deps {
  prisma: any;
  env: { sendEnabled: boolean; resumeEnabled?: boolean; graphVersion: string; encryptionKey: string };
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

const host = (mode: string) => (mode === "FACEBOOK" ? "https://graph.facebook.com" : "https://graph.instagram.com");
const clean = (s: unknown, token: string) => String(s ?? "").split(token).join("[token]").slice(0, 300);

/** Marca gravada em MessageDelivery.error quando a entrega nasceu com o envio desligado. */
export const DISABLED_NOTE = "envio desabilitado (INSTAGRAM_SEND_ENABLED=false)";

/** Códigos de limite de taxa da Meta (além do HTTP 429). Rejeição = não enviou; só registramos à parte. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Falha transitória da consulta (rede/5xx): o job deve ser repetido, a entrega segue PENDING. */
export class TransientError extends Error {}

/** Texto enviado = mensagem + link (separado no cadastro). */
export const buildMessage = (replyMessage: string, linkUrl?: string | null) =>
  linkUrl ? `${replyMessage} ${linkUrl}` : replyMessage;

const parseMetaTime = (t: unknown) => {
  const d = new Date(String(t ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * PROCESSED no evento = "o worker terminou de tratar". A verdade sobre a mensagem está
 * em MessageDelivery.status (SENT/FAILED/UNKNOWN). PENDING nunca é terminal.
 */
export async function processCommentEvent(deps: Deps, raw: unknown) {
  const { prisma, env } = deps;
  const data: CommentEventJob = commentEventJobSchema.parse(raw);
  const now = deps.now ?? (() => new Date());
  const f = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const setEvent = (d: Record<string, unknown>) => prisma.automationEvent.update({ where: { id: data.eventId }, data: d });

  const account = await prisma.socialAccount.findUnique({
    where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: data.igAccountId } },
    include: { credential: true },
  });
  if (!account) return setEvent({ status: "IGNORED", error: "conta desconhecida" });

  // Comentário da própria conta profissional (inclusive nossas respostas): nunca responder.
  if (data.fromId && data.fromId === account.providerAccountId) return setEvent({ status: "IGNORED", error: "comentário da própria conta" });

  const automations = await prisma.automation.findMany({
    where: { socialAccountId: account.id, status: "ACTIVE", media: { providerMediaId: data.mediaId } },
  });
  const text = normalizeKeyword(data.text);
  const match = automations.find((a: any) => text.includes(normalizeKeyword(a.keyword)));
  if (!match) return setEvent({ status: "IGNORED" });
  if (match.organizationId !== account.organizationId) return setEvent({ status: "FAILED", error: "organização da automação difere da conta" });

  // Reserva idempotente (unique commentId). Persistida ANTES de qualquer chamada externa.
  let delivery: any;
  try {
    delivery = await prisma.messageDelivery.create({
      data: { organizationId: match.organizationId, automationId: match.id, commentId: data.commentId },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
    delivery = await prisma.messageDelivery.findUnique({ where: { commentId: data.commentId } });
    if (!delivery) return;
    // Vínculo explícito: a entrega existente tem de ser desta organização E desta automação.
    if (delivery.organizationId !== match.organizationId || delivery.automationId !== match.id) {
      return setEvent({ status: "FAILED", error: "entrega existente pertence a outra automação/organização" });
    }
    if (delivery.status !== "PENDING") return; // já tratado: webhook duplicado não reenvia
    // Nasceu com o envio desligado: só sai pela retomada explícita (INSTAGRAM_RESUME_PENDING_ENABLED),
    // nem por reentrega de webhook. Retentativa de job normal (error nulo) segue o fluxo.
    if (delivery.error === DISABLED_NOTE && !env.resumeEnabled) {
      return setEvent({ error: "entrega PENDING: retomada desabilitada (INSTAGRAM_RESUME_PENDING_ENABLED=false)" });
    }
  }
  await setEvent({ organizationId: match.organizationId, socialAccountId: account.id });

  const finish = async (status: "SENT" | "FAILED" | "UNKNOWN", error: string | null, providerResponse?: unknown) => {
    await prisma.messageDelivery.update({
      where: { id: delivery.id },
      data: { status, error, ...(providerResponse !== undefined ? { providerResponse } : {}) },
    });
    await setEvent({ status: "PROCESSED", error: status === "SENT" ? null : `entrega ${status}: ${error}` });
  };

  // Envio desligado: nenhuma chamada à Meta. A entrega fica PENDING e o evento RECEIVED (retomável).
  if (!env.sendEnabled) {
    await prisma.messageDelivery.update({ where: { id: delivery.id }, data: { error: DISABLED_NOTE } });
    return setEvent({ error: `entrega PENDING: ${DISABLED_NOTE}` });
  }

  // PENDING com tentativa já registrada = processo caiu durante o envio: resultado ambíguo.
  if (delivery.attempts > 0) return finish("UNKNOWN", "processo interrompido durante o envio; resultado incerto");

  const cred = account.credential;
  if (!cred) return finish("FAILED", "conta sem credencial");
  if (cred.expiresAt && cred.expiresAt.getTime() <= now().getTime()) return finish("FAILED", "token expirado");

  let token: string;
  try {
    token = decryptToken({ encrypted: cred.encryptedToken, iv: cred.tokenIv, tag: cred.tokenTag }, env.encryptionKey);
  } catch {
    return finish("FAILED", "não foi possível decifrar a credencial");
  }
  const base = `${host(cred.loginMode)}/${env.graphVersion}`;
  const auth = { authorization: `Bearer ${token}` };

  // 1) Idade do comentário vem da Meta (o webhook não traz timestamp confiável).
  let createdAt: Date | null;
  try {
    const res = await f(`${base}/${encodeURIComponent(data.commentId)}?fields=timestamp`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500 || res.status === 429) throw new TransientError(`consulta do comentário: HTTP ${res.status}`);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) return finish("FAILED", `não foi possível confirmar a idade do comentário (HTTP ${res.status}, código ${body?.error?.code ?? "?"})`);
    createdAt = parseMetaTime(body?.timestamp);
  } catch (e) {
    if (e instanceof TransientError) throw e;
    throw new TransientError("consulta do comentário: rede/timeout");
  }
  if (!createdAt) return finish("FAILED", "idade do comentário não confirmada");
  if (now().getTime() - createdAt.getTime() > REPLY_WINDOW_MS) return finish("FAILED", "comentário com mais de 7 dias");

  // 2) Claim atômico + contador gravado antes do envio: dois workers nunca enviam o mesmo comentário.
  const claim = await prisma.messageDelivery.updateMany({ where: { id: delivery.id, status: "PENDING", attempts: 0 }, data: { attempts: 1 } });
  if (claim.count !== 1) return;

  // 3) Envio. Sem retry automático depois deste ponto.
  const message = buildMessage(match.replyMessage, match.linkUrl);
  let res: Response;
  try {
    res = await f(`${base}/${account.providerAccountId}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { comment_id: data.commentId }, message: { text: message } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return finish("UNKNOWN", "timeout/erro de rede após chamar a Meta; não reenviar às cegas");
  }
  const body: any = await res.json().catch(() => null);
  if (res.ok) {
    if (body?.message_id) {
      log(`private reply enviada (delivery=${delivery.id})`);
      return finish("SENT", null, { recipient_id: body.recipient_id, message_id: body.message_id });
    }
    return finish("UNKNOWN", "Meta respondeu 2xx sem message_id");
  }
  if (res.status >= 500) return finish("UNKNOWN", `Meta respondeu HTTP ${res.status}; resultado incerto`, { http: res.status });
  const err = body?.error ?? {};
  // Limite de taxa: a Meta recusou, então nada foi enviado; continua FAILED (sem retry automático),
  // mas sinalizado à parte para análise/reconciliação manual.
  const rateLimited = res.status === 429 || RATE_LIMIT_CODES.has(Number(err.code));
  return finish("FAILED", `${rateLimited ? "RATE LIMIT: " : ""}Meta rejeitou (HTTP ${res.status}, código ${err.code ?? "?"}${err.error_subcode ? `/${err.error_subcode}` : ""}): ${clean(err.message, token)}`, {
    http: res.status, code: err.code, error_subcode: err.error_subcode, type: err.type, fbtrace_id: err.fbtrace_id, rateLimited,
  });
}

export interface ResumeReport { scanned: number; resumed: number; skipped: number; failed: number }

/**
 * Retomada explícita de entregas PENDING (nascidas com o envio desligado). Só roda se
 * INSTAGRAM_RESUME_PENDING_ENABLED=true. Pagina por cursor, relata o resultado e não engole erros.
 */
export async function resumePending(deps: Deps, opts: { batch?: number; max?: number } = {}): Promise<ResumeReport> {
  const { prisma } = deps;
  const log = deps.log ?? (() => {});
  const batch = opts.batch ?? 100;
  const max = opts.max ?? 1000;
  const report: ResumeReport = { scanned: 0, resumed: 0, skipped: 0, failed: 0 };
  let cursor: string | undefined;

  while (report.scanned < max) {
    const page = await prisma.messageDelivery.findMany({
      where: { status: "PENDING", attempts: 0 },
      orderBy: { id: "asc" },
      take: batch,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1].id;
    report.scanned += page.length;

    for (const d of page) {
      const ev = await prisma.automationEvent.findUnique({ where: { providerEventKey: `comment:${d.commentId}` }, include: { socialAccount: true } });
      const v = (ev?.payload as any)?.value;
      if (!ev || ev.status !== "RECEIVED" || !ev.socialAccount || !v) { report.skipped++; continue; }
      try {
        await processCommentEvent(deps, {
          eventId: ev.id,
          igAccountId: ev.socialAccount.providerAccountId,
          commentId: String(d.commentId),
          mediaId: String(v.media?.id ?? ""),
          text: String(v.text ?? ""),
          fromId: v.from?.id ? String(v.from.id) : undefined,
        });
        report.resumed++;
      } catch (e) {
        report.failed++;
        log(`retomada falhou (delivery=${d.id}): ${e instanceof Error ? e.message : "erro desconhecido"}`);
      }
    }
    if (page.length < batch) break;
  }
  log(`retomada: ${JSON.stringify(report)}`);
  return report;
}
