import { parseCommentEventJob, type CommentEventJob, type CommentJobOutcome, type CommentJobResult } from "@dabi/contracts";
import { processCommentEvent, type Deps } from "./process-comment";
import { invalidJobError, safeErrorText, toSafeJobError } from "./safe-error";

type Process = (deps: Deps, job: CommentEventJob) => Promise<unknown>;

/** Mesma regra do webhook (`value.comment_id ?? value.id`) e do `resumePending`. */
export function jobFromEventPayload(eventId: string, igAccountId: string, payload: any): CommentEventJob | null {
  const v = payload?.value;
  const commentId = v?.comment_id ?? v?.id;
  if (!v || !commentId) return null;
  return {
    eventId,
    igAccountId,
    commentId: String(commentId),
    mediaId: String(v.media?.id ?? ""),
    text: String(v.text ?? ""),
    fromId: v.from?.id ? String(v.from.id) : undefined,
  };
}

/** O que o processamento devolve (linha do evento) vira só um desfecho. Nada do evento sai daqui. */
export function outcomeOf(result: unknown): CommentJobOutcome {
  const status = (result as { status?: unknown } | null | undefined)?.status;
  if (status === "IGNORED") return "ignored";
  return "processed";
}

async function tombstoned(deps: Deps, commentId: string): Promise<boolean> {
  const t = await deps.prisma.idempotencyTombstone.findUnique({ where: { commentId } });
  if (!t) return false;
  const now = (deps.now ?? (() => new Date()))();
  return new Date(t.expiresAt).getTime() > now.getTime();
}

/**
 * Entrada do Worker do BullMQ. Aceita os DOIS formatos de job e devolve SÓ `{ outcome }`.
 *
 * Regras (nenhuma delas envia mensagem por conta própria; o envio continua sendo todo do `processCommentEvent`):
 * - job com formato inválido            → UnrecoverableError (não repete), sem o conteúdo na mensagem;
 * - evento ausente ou já tratado        → `dropped`, sem retry e sem enviar;
 * - comentário protegido por tombstone  → `dropped` (e o evento duplicado vira IGNORED);
 * - `igAccountId` ausente ou associação inconsistente → `needs_review`: NADA é enviado e o evento NÃO vira estado
 *   terminal (continua RECEIVED, com uma nota), para análise;
 * - conta desconhecida                  → IGNORED, como no formato legado;
 * - falha de banco/rede ANTES do claim  → erro transitório normalizado: o BullMQ repete (nada foi reservado);
 * - qualquer outro erro                 → normalizado (classe + código), sem mensagem, sem dados do comentário.
 */
export async function handleCommentJob(deps: Deps, raw: unknown, run: Process = processCommentEvent): Promise<CommentJobResult> {
  const log = deps.log ?? (() => {});
  try {
    const parsed = parseCommentEventJob(raw);
    if (parsed.kind === "invalid") throw invalidJobError(parsed.reason);

    if (parsed.kind === "legacy") {
      if (await tombstoned(deps, parsed.job.commentId)) {
        await deps.prisma.automationEvent.updateMany({ where: { id: parsed.job.eventId, status: "RECEIVED" }, data: { status: "IGNORED", error: "comentário já tratado anteriormente (tombstone)" } });
        log(`job legado evento=${parsed.job.eventId} resultado=dropped`);
        return { outcome: "dropped" };
      }
      const outcome = outcomeOf(await run(deps, parsed.job));
      log(`job legado evento=${parsed.job.eventId} resultado=${outcome}`);
      return { outcome };
    }

    // formato mínimo: tudo vem do banco, no momento do processamento
    const { eventId } = parsed.job;
    const ev = await deps.prisma.automationEvent.findUnique({ where: { id: eventId } });
    if (!ev) { log(`job mínimo evento=${eventId} resultado=dropped (evento ausente)`); return { outcome: "dropped" }; }
    if (ev.status !== "RECEIVED") { log(`job mínimo evento=${eventId} resultado=dropped (já tratado)`); return { outcome: "dropped" }; }

    const note = (error: string) => deps.prisma.automationEvent.updateMany({ where: { id: eventId, status: "RECEIVED" }, data: { error } });

    if (!ev.igAccountId) {
      await note("sem conta associada (igAccountId ausente); nada foi enviado; requer análise");
      log(`job mínimo evento=${eventId} resultado=needs_review (igAccountId ausente)`);
      return { outcome: "needs_review" };
    }
    const job = jobFromEventPayload(eventId, ev.igAccountId, ev.payload);
    if (!job) {
      await note("payload sem id do comentário; nada foi enviado; requer análise");
      log(`job mínimo evento=${eventId} resultado=needs_review (payload sem comentário)`);
      return { outcome: "needs_review" };
    }
    if (await tombstoned(deps, job.commentId)) {
      await deps.prisma.automationEvent.updateMany({ where: { id: eventId, status: "RECEIVED" }, data: { status: "IGNORED", error: "comentário já tratado anteriormente (tombstone)" } });
      log(`job mínimo evento=${eventId} resultado=dropped (tombstone)`);
      return { outcome: "dropped" };
    }

    const account = await deps.prisma.socialAccount.findUnique({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: job.igAccountId } },
      select: { id: true, organizationId: true },
    });
    if (account) {
      // Associação já gravada no evento tem de bater com a conta encontrada: senão, não envia e não finaliza.
      const diverge = (ev.socialAccountId && ev.socialAccountId !== account.id) || (ev.organizationId && ev.organizationId !== account.organizationId);
      if (diverge) {
        await note("associação do evento diverge da conta encontrada; nada foi enviado; requer análise");
        log(`job mínimo evento=${eventId} resultado=needs_review (associação inconsistente)`);
        return { outcome: "needs_review" };
      }
    }
    // conta desconhecida: o processamento marca IGNORED, como no formato legado (paridade)
    const outcome = outcomeOf(await run(deps, job));
    log(`job mínimo evento=${eventId} resultado=${outcome}`);
    return { outcome };
  } catch (e) {
    const safe = toSafeJobError(e);
    log(`job falhou: ${safeErrorText(safe)}`);
    throw safe;
  }
}
