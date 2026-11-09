/**
 * Reconciliação APÓS RESTAURAÇÃO de backup. Fonte: o registro durável (ledger), independente do banco.
 *
 * Problema: um backup antigo não tem os tombstones criados depois dele, e traz de volta registros que a retenção já apagou. Executar só
 * o dry-run não recupera nada disso. Procedimento (runbook):
 *   0. ANTES de subir qualquer serviço: ligar o bloqueio (setRestoreHold). O claim e o handler recusam qualquer processamento.
 *   1. reconcileFromLedger: para cada entrada `done` ainda dentro da janela do tombstone, recria/renova o tombstone (GREATEST) e
 *      reexclui as partes que a retenção já havia excluído e que reapareceram (atomicamente, por comentário).
 *   2. verifyReconciliation: confere que TODA entrada dentro da janela tem tombstone válido e que não há registro "ressuscitado".
 *   3. só se a verificação passar: desligar o bloqueio. Qualquer falha mantém o bloqueio ligado.
 * Idempotente: pode ser repetida sem efeito colateral. Entradas `intent` sem `done` são tratadas como `done` (apenas adicionam proteção).
 */
import { purgeCommentUnit } from "./purge";
import type { FileLedger, LedgerLine } from "./ledger";

export const RESTORE_HOLD_ID = "restore-hold";

export async function setRestoreHold(prisma: any, on: boolean, reason = "restore"): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "RetentionLease" ("id", "epoch", "updatedAt") VALUES (${RESTORE_HOLD_ID}, 0, NOW()) ON CONFLICT ("id") DO NOTHING`;
  if (on) await prisma.$executeRaw`UPDATE "RetentionLease" SET "owner" = ${reason}, "heartbeatAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${RESTORE_HOLD_ID}`;
  else await prisma.$executeRaw`UPDATE "RetentionLease" SET "owner" = NULL, "updatedAt" = NOW() WHERE "id" = ${RESTORE_HOLD_ID}`;
}
export const isRestoreHoldOn = async (prisma: any) => Boolean((await prisma.retentionLease.findUnique({ where: { id: RESTORE_HOLD_ID } }))?.owner);

export interface ReconcileReport { entriesInWindow: number; commentsInWindow: number; tombstonesRecreated: number; tombstonesRenewed: number; rowsReDeleted: { events: number; deliveries: number; replies: number }; transitionsReapplied: number }
export interface VerifyReport { ok: boolean; missingTombstones: string[]; resurrected: string[]; unreappliedTransitions: string[]; chainError?: string }

type Window = { commentId: string; event: boolean; records: boolean; expiresAt: Date; ttlSeconds: number };

/** Entradas ainda dentro da janela de proteção (at + ttl > now), unificadas por comentário (mantém o maior prazo e a união das partes). */
function windowed(ledger: FileLedger, now: Date): { entries: number; byComment: Map<string, Window>; transitions: NonNullable<LedgerLine["transitions"]> } {
  const lines = ledger.read(); // também verifica a cadeia: adulteração lança
  const by = new Map<string, Window>(); let entries = 0; const transitions: NonNullable<LedgerLine["transitions"]> = [];
  for (const l of lines) {
    const exp = new Date(new Date(l.at).getTime() + l.ttlSeconds * 1000);
    if (exp.getTime() <= now.getTime()) continue;
    entries++;
    for (const t of l.transitions ?? []) transitions.push(t);
    for (const it of l.items) {
      const cur = by.get(it.commentId);
      by.set(it.commentId, { commentId: it.commentId, event: (cur?.event ?? false) || it.event, records: (cur?.records ?? false) || it.records, expiresAt: !cur || exp > cur.expiresAt ? exp : cur.expiresAt, ttlSeconds: l.ttlSeconds });
    }
  }
  return { entries, byComment: by, transitions };
}

export async function reconcileFromLedger(prisma: any, ledger: FileLedger, now = new Date()): Promise<ReconcileReport> {
  const { entries, byComment, transitions } = windowed(ledger, now);
  const rep: ReconcileReport = { entriesInWindow: entries, commentsInWindow: byComment.size, tombstonesRecreated: 0, tombstonesRenewed: 0, rowsReDeleted: { events: 0, deliveries: 0, replies: 0 }, transitionsReapplied: 0 };
  for (const w of byComment.values()) {
    // Preserva a expiração ORIGINAL como data absoluta (não depende de relógio; nunca encurta: GREATEST)
    const had = await prisma.idempotencyTombstone.findUnique({ where: { commentId: w.commentId } });
    const res = await prisma.$transaction((tx: any) => purgeCommentUnit(tx, w.commentId, { event: w.event, records: w.records }, w.expiresAt));
    if (!had) rep.tombstonesRecreated++; else rep.tombstonesRenewed++;
    rep.rowsReDeleted.events += res.events; rep.rowsReDeleted.deliveries += res.deliveries; rep.rowsReDeleted.replies += res.replies;
  }
  // Transições de estado: a restauração traz de volta o estado ANTERIOR (ex.: HELD já cancelada). Reaplica por compare-and-set.
  for (const t of transitions) {
    const model = t.target === "dm" ? "messageDelivery" : "publicReply";
    const r = await prisma[model].updateMany({ where: { commentId: t.commentId, status: t.fromStatus, attempts: t.fromAttempts }, data: { status: t.to, error: t.to === "CANCELED" ? "retention.canceled" : "retention.unknown_after_stall" } });
    rep.transitionsReapplied += r.count;
  }
  return rep;
}

export async function verifyReconciliation(prisma: any, ledger: FileLedger, now = new Date()): Promise<VerifyReport> {
  let byComment: Map<string, Window>; let transitions: NonNullable<LedgerLine["transitions"]>;
  try { const w = windowed(ledger, now); byComment = w.byComment; transitions = w.transitions; } catch (e) { return { ok: false, missingTombstones: [], resurrected: [], unreappliedTransitions: [], chainError: (e as Error).message }; }
  const missing: string[] = []; const resurrected: string[] = []; const unreapplied: string[] = [];
  for (const w of byComment.values()) {
    const t = await prisma.idempotencyTombstone.findUnique({ where: { commentId: w.commentId } });
    if (!t || new Date(t.expiresAt).getTime() < w.expiresAt.getTime() - 1000) missing.push(w.commentId);
    const [e, d, p] = await Promise.all([w.event ? prisma.automationEvent.count({ where: { providerEventKey: `comment:${w.commentId}` } }) : 0, w.records ? prisma.messageDelivery.count({ where: { commentId: w.commentId } }) : 0, w.records ? prisma.publicReply.count({ where: { commentId: w.commentId } }) : 0]);
    if (e + d + p > 0) resurrected.push(w.commentId);
  }
  // uma transição registrada cujo estado de ORIGEM ainda existe = estado antigo restaurado e não reaplicado
  for (const t of transitions) {
    const model = t.target === "dm" ? "messageDelivery" : "publicReply";
    if (await prisma[model].count({ where: { commentId: t.commentId, status: t.fromStatus, attempts: t.fromAttempts } })) unreapplied.push(t.commentId);
  }
  return { ok: missing.length === 0 && resurrected.length === 0 && unreapplied.length === 0, missingTombstones: missing, resurrected, unreappliedTransitions: unreapplied };
}

/** Fluxo completo e fail-closed: o bloqueio só é desligado se a verificação passar. */
export async function reconcileAndRelease(prisma: any, ledger: FileLedger, now = new Date()): Promise<{ reconcile: ReconcileReport | null; verify: VerifyReport; released: boolean }> {
  await setRestoreHold(prisma, true, "reconciliation");
  let reconcile: ReconcileReport | null = null; let verify: VerifyReport;
  try { reconcile = await reconcileFromLedger(prisma, ledger, now); verify = await verifyReconciliation(prisma, ledger, now); }
  catch (e) { verify = { ok: false, missingTombstones: [], resurrected: [], unreappliedTransitions: [], chainError: (e as Error).message }; }
  if (verify.ok) await setRestoreHold(prisma, false);
  return { reconcile, verify, released: verify.ok };
}
