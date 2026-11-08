import { commentEventJobSchema, normalizeKeyword, validateReplyShape, DEFAULT_BUTTON_TITLE, type CommentEventJob } from "@dabi/contracts";
import { decryptToken } from "@dabi/config";

/** Resposta privada só é aceita pela Meta até 7 dias após o comentário. */
export const REPLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface Deps {
  prisma: any;
  env: { sendEnabled: boolean; resumeEnabled?: boolean; publicReplyEnabled?: boolean; graphVersion: string; encryptionKey: string };
  fetchImpl?: typeof fetch;
  now?: () => Date;
  log?: (msg: string) => void;
}

const host = (mode: string) => (mode === "FACEBOOK" ? "https://graph.facebook.com" : "https://graph.instagram.com");
const clean = (s: unknown, token: string) => String(s ?? "").split(token).join("[token]").slice(0, 300);

/** Texto (só informativo) gravado em MessageDelivery.error quando a entrega é retida (status HELD). */
export const DISABLED_NOTE = "envio desabilitado (INSTAGRAM_SEND_ENABLED=false)";

/** Códigos de limite de taxa da Meta (além do HTTP 429). Rejeição = não enviou; só registramos à parte. */
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);

/** Erro 190 da Meta: token inválido/revogado/expirado. A requisição foi REJEITADA (nada foi enviado). */
const isInvalidToken = (err: any) => Number(err?.code) === 190;
export const RECONNECT_NOTE = "credencial inválida ou revogada: reconecte a conta no DaBiChat";

/**
 * Marca SÓ a credencial desta conta como "precisa reconectar". O filtro pelo token usado evita sobrescrever
 * uma reconexão que tenha acontecido enquanto a chamada estava em andamento. Idempotente.
 */
async function flagCredential(ctx: Ctx) {
  const cred = ctx.account.credential;
  if (!cred) return;
  const now = ctx.deps.now ?? (() => new Date());
  await ctx.deps.prisma.socialCredential.updateMany({
    where: { socialAccountId: ctx.account.id, status: "ACTIVE", encryptedToken: cred.encryptedToken },
    data: { status: "NEEDS_RECONNECT", statusReason: "A Meta recusou o token (código 190)", statusChangedAt: now() },
  });
}

/** Falha transitória da consulta (rede/5xx): o job deve ser repetido, a entrega segue PENDING. */
export class TransientError extends Error {}

/** Texto enviado = mensagem + link (separado no cadastro). */
export const buildMessage = (replyMessage: string, linkUrl?: string | null) =>
  linkUrl ? `${replyMessage} ${linkUrl}` : replyMessage;

/** TEXT => texto (+ link); BUTTON => generic template com um botão web_url (docs: máx. 80 caracteres no título). */
export function buildMessagePayload(a: { replyFormat?: string | null; replyMessage: string; linkUrl?: string | null; buttonTitle?: string | null }) {
  if (a.replyFormat === "BUTTON") {
    return {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{ title: a.replyMessage, buttons: [{ type: "web_url", url: a.linkUrl, title: a.buttonTitle || DEFAULT_BUTTON_TITLE }] }],
        },
      },
    };
  }
  return { text: buildMessage(a.replyMessage, a.linkUrl) };
}

const parseMetaTime = (t: unknown) => {
  const d = new Date(String(t ?? "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isNaN(d.getTime()) ? null : d;
};

type Status = "SENT" | "FAILED" | "UNKNOWN";
type Ctx = { deps: Deps; data: CommentEventJob; account: any; match: any; setEvent: (d: Record<string, unknown>) => Promise<any> };
type DmResult = { kind: "stop"; result?: unknown } | { kind: "done"; status: Status; error: string | null };

/** Credencial -> host/versão/header. Nunca devolve o token em mensagens de erro. */
function resolveAuth(ctx: Ctx): { base: string; auth: Record<string, string>; token: string } | { error: string } {
  const { deps, account } = ctx;
  const cred = account.credential;
  if (!cred) return { error: "conta sem credencial" };
  if (cred.expiresAt && cred.expiresAt.getTime() <= (deps.now ?? (() => new Date()))().getTime()) return { error: "token expirado" };
  try {
    const token = decryptToken({ encrypted: cred.encryptedToken, iv: cred.tokenIv, tag: cred.tokenTag }, deps.env.encryptionKey);
    return { base: `${host(cred.loginMode)}/${deps.env.graphVersion}`, auth: { authorization: `Bearer ${token}` }, token };
  } catch {
    return { error: "não foi possível decifrar a credencial" };
  }
}

const metaError = (res: Response, err: any, token: string) => {
  const rateLimited = res.status === 429 || RATE_LIMIT_CODES.has(Number(err.code));
  return {
    error: `${rateLimited ? "RATE LIMIT: " : ""}Meta rejeitou (HTTP ${res.status}, código ${err.code ?? "?"}${err.error_subcode ? `/${err.error_subcode}` : ""}): ${clean(err.message, token)}`,
    response: { http: res.status, code: err.code, error_subcode: err.error_subcode, type: err.type, fbtrace_id: err.fbtrace_id, rateLimited },
  };
};

/**
 * PROCESSED no evento = "o worker terminou de tratar". A verdade está em MessageDelivery.status (DM)
 * e PublicReply.status (resposta pública): SENT/FAILED/UNKNOWN. PENDING nunca é terminal.
 * A resposta pública só sai depois da DM confirmada (SENT) quando a DM está habilitada.
 */
export async function processCommentEvent(deps: Deps, raw: unknown) {
  const { prisma, env } = deps;
  const data: CommentEventJob = commentEventJobSchema.parse(raw);
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

  const dmOn = match.dmEnabled !== false;
  const pubOn = match.publicReplyEnabled === true;
  if (!dmOn && !pubOn) return setEvent({ status: "IGNORED", error: "nenhuma ação habilitada na automação" });

  const ctx: Ctx = { deps, data, account, match, setEvent };

  let dm: { status: Status; error: string | null } | null = null;
  if (dmOn) {
    const r = await runDm(ctx);
    if (r.kind === "stop") return r.result;
    dm = r;
  } else {
    await setEvent({ organizationId: match.organizationId, socialAccountId: account.id });
  }

  // Resposta pública: independente da DM quando a DM está desabilitada; com DM habilitada, só após SENT.
  let pubNote: string | null = null;
  if (pubOn && (!dmOn || dm?.status === "SENT")) {
    if (!env.publicReplyEnabled) {
      pubNote = "resposta pública desabilitada (INSTAGRAM_PUBLIC_REPLY_ENABLED=false)";
    } else if (account.credential?.status === "NEEDS_RECONNECT") {
      pubNote = `resposta pública não enviada: ${RECONNECT_NOTE}`;
    } else {
      const pr = await runPublicReply(ctx);
      if (pr.status !== "SENT") pubNote = `resposta pública ${pr.status}: ${pr.error}`;
    }
  }
  const dmNote = dm && dm.status !== "SENT" ? `entrega ${dm.status}: ${dm.error}` : null;
  return setEvent({ status: "PROCESSED", error: [dmNote, pubNote].filter(Boolean).join(" | ") || null });
}

/** Resposta pública: POST /{comment-id}/replies. Claim atômico antes da chamada; sem retry após resultado ambíguo. */
async function runPublicReply(ctx: Ctx): Promise<{ status: Status; error: string | null }> {
  const { deps, data, match } = ctx;
  const { prisma } = deps;
  const f = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});

  let row: any;
  try {
    row = await prisma.publicReply.create({ data: { organizationId: match.organizationId, automationId: match.id, commentId: data.commentId } });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
    row = await prisma.publicReply.findUnique({ where: { commentId: data.commentId } });
    if (!row) return { status: "UNKNOWN", error: "resposta pública não localizada" };
    if (row.organizationId !== match.organizationId || row.automationId !== match.id) {
      return { status: "FAILED", error: "resposta pública existente pertence a outra automação/organização" };
    }
    if (row.status !== "PENDING") return { status: row.status, error: row.error }; // já tratada: duplicado não republica
  }
  const finish = async (status: Status, error: string | null, providerResponse?: unknown) => {
    await prisma.publicReply.update({ where: { id: row.id }, data: { status, error, ...(providerResponse !== undefined ? { providerResponse } : {}) } });
    return { status, error };
  };

  if (row.attempts > 0) return finish("UNKNOWN", "processo interrompido durante a publicação; resultado incerto");
  const message = String(match.publicReplyMessage ?? "").trim();
  if (!message) return finish("FAILED", "mensagem pública ausente");
  const a = resolveAuth(ctx);
  if ("error" in a) return finish("FAILED", a.error);

  const claim = await prisma.publicReply.updateMany({ where: { id: row.id, status: "PENDING", attempts: 0 }, data: { attempts: 1 } });
  if (claim.count !== 1) return { status: "UNKNOWN", error: "outra execução assumiu a resposta pública" };

  let res: Response;
  try {
    const url = `${a.base}/${encodeURIComponent(data.commentId)}/replies?${new URLSearchParams({ message })}`;
    res = await f(url, { method: "POST", headers: a.auth, signal: AbortSignal.timeout(15_000) });
  } catch {
    return finish("UNKNOWN", "timeout/erro de rede após chamar a Meta; não republicar às cegas");
  }
  const body: any = await res.json().catch(() => null);
  if (res.ok) {
    if (body?.id) {
      log(`resposta pública publicada (publicReply=${row.id})`);
      return finish("SENT", null, { id: body.id });
    }
    return finish("UNKNOWN", "Meta respondeu 2xx sem id da resposta");
  }
  if (res.status >= 500) return finish("UNKNOWN", `Meta respondeu HTTP ${res.status}; resultado incerto`, { http: res.status });
  if (isInvalidToken(body?.error)) { await flagCredential(ctx); return finish("FAILED", RECONNECT_NOTE, { http: res.status, code: 190 }); }
  const m = metaError(res, body?.error ?? {}, a.token);
  return finish("FAILED", m.error, m.response);
}

/** DM privada (Private Reply). Mesma lógica de antes; retorna o resultado em vez de fechar o evento. */
async function runDm(ctx: Ctx): Promise<DmResult> {
  const { deps, data, account, match, setEvent } = ctx;
  const { prisma, env } = deps;
  const now = deps.now ?? (() => new Date());
  const f = deps.fetchImpl ?? fetch;
  const log = deps.log ?? (() => {});
  const stop = async (p?: Promise<unknown>): Promise<DmResult> => ({ kind: "stop", result: p ? await p : undefined });

  // Reserva idempotente (unique commentId). Persistida ANTES de qualquer chamada externa.
  let delivery: any;
  try {
    delivery = await prisma.messageDelivery.create({
      data: { organizationId: match.organizationId, automationId: match.id, commentId: data.commentId },
    });
  } catch (e: any) {
    if (e?.code !== "P2002") throw e;
    delivery = await prisma.messageDelivery.findUnique({ where: { commentId: data.commentId } });
    if (!delivery) return stop();
    // Vínculo explícito: a entrega existente tem de ser desta organização E desta automação.
    if (delivery.organizationId !== match.organizationId || delivery.automationId !== match.id) {
      return stop(setEvent({ status: "FAILED", error: "entrega existente pertence a outra automação/organização" }));
    }
    if (delivery.status === "SENT") {
      // DM já enviada. Só segue (para a resposta pública) se o evento ficou inacabado, por queda do processo.
      const ev = await prisma.automationEvent.findUnique({ where: { id: data.eventId } });
      return ev?.status === "RECEIVED" ? { kind: "done", status: "SENT", error: null } : stop();
    }
    if (delivery.status === "HELD") {
      // Retida de propósito: só sai com envio E retomada habilitados. Reentrega de webhook não libera.
      if (!env.sendEnabled || !env.resumeEnabled) {
        return stop(setEvent({ error: "entrega HELD: retomada desabilitada (INSTAGRAM_RESUME_PENDING_ENABLED=false)" }));
      }
      // Liberação atômica HELD -> PENDING: só uma execução consegue.
      const rel = await prisma.messageDelivery.updateMany({ where: { id: delivery.id, status: "HELD" }, data: { status: "PENDING", error: null } });
      if (rel.count !== 1) return stop();
      delivery = { ...delivery, status: "PENDING", error: null };
    } else if (delivery.status !== "PENDING") {
      return stop(); // já tratado: webhook duplicado não reenvia
    }
  }
  await setEvent({ organizationId: match.organizationId, socialAccountId: account.id });

  const finish = async (status: Status, error: string | null, providerResponse?: unknown): Promise<DmResult> => {
    await prisma.messageDelivery.update({
      where: { id: delivery.id },
      data: { status, error, ...(providerResponse !== undefined ? { providerResponse } : {}) },
    });
    return { kind: "done", status, error };
  };

  // Envio desligado: nenhuma chamada à Meta. A entrega fica HELD e o evento RECEIVED (retomável).
  if (!env.sendEnabled) {
    await prisma.messageDelivery.update({ where: { id: delivery.id }, data: { status: "HELD", error: DISABLED_NOTE } });
    return stop(setEvent({ error: `entrega HELD: ${DISABLED_NOTE}` }));
  }

  // Credencial já marcada para reconexão: não chama a Meta. Retém só as entregas desta conta.
  const holdForReconnect = async (): Promise<DmResult> => {
    await prisma.messageDelivery.update({ where: { id: delivery.id }, data: { status: "HELD", attempts: 0, error: RECONNECT_NOTE } });
    return stop(setEvent({ error: `entrega HELD: ${RECONNECT_NOTE}` }));
  };
  if (account.credential?.status === "NEEDS_RECONNECT") return holdForReconnect();

  // PENDING com tentativa já registrada = processo caiu durante o envio: resultado ambíguo.
  if (delivery.attempts > 0) return finish("UNKNOWN", "processo interrompido durante o envio; resultado incerto");

  const shapeError = validateReplyShape(match);
  if (shapeError) return finish("FAILED", `automação inválida: ${shapeError}`);

  const a = resolveAuth(ctx);
  if ("error" in a) return finish("FAILED", a.error);
  const { base, auth, token } = a;

  // 1) Idade do comentário vem da Meta (o webhook não traz timestamp confiável).
  let createdAt: Date | null;
  try {
    const res = await f(`${base}/${encodeURIComponent(data.commentId)}?fields=timestamp`, { headers: auth, signal: AbortSignal.timeout(10_000) });
    if (res.status >= 500 || res.status === 429) throw new TransientError(`consulta do comentário: HTTP ${res.status}`);
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok && isInvalidToken(body?.error)) { await flagCredential(ctx); return holdForReconnect(); }
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
  if (claim.count !== 1) return stop();

  // 3) Envio. Sem retry automático depois deste ponto.
  const message = buildMessagePayload(match);
  let res: Response;
  try {
    res = await f(`${base}/${account.providerAccountId}/messages`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { comment_id: data.commentId }, message }),
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
  // Token inválido/revogado (190): a Meta recusou, nada foi enviado. Retém (HELD, attempts=0) e pede reconexão.
  if (isInvalidToken(body?.error)) { await flagCredential(ctx); return holdForReconnect(); }
  // Limite de taxa: a Meta recusou, então nada foi enviado; continua FAILED (sem retry automático),
  // mas sinalizado à parte para análise/reconciliação manual.
  const m = metaError(res, body?.error ?? {}, token);
  return finish("FAILED", m.error, m.response);
}

export interface ResumeReport { scanned: number; resumed: number; skipped: number; failed: number }

/**
 * Retomada explícita de entregas HELD (retidas com o envio desligado). Só roda se
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
      where: { status: "HELD", attempts: 0 },
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
