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
import type { FileLedger } from "./ledger";

export const RESTORE_HOLD_ID = "restore-hold";

export async function setRestoreHold(prisma: any, on: boolean, reason = "restore"): Promise<void> {
  await prisma.$executeRaw`INSERT INTO "RetentionLease" ("id", "epoch", "updatedAt") VALUES (${RESTORE_HOLD_ID}, 0, NOW()) ON CONFLICT ("id") DO NOTHING`;
  if (on) await prisma.$executeRaw`UPDATE "RetentionLease" SET "owner" = ${reason}, "heartbeatAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${RESTORE_HOLD_ID}`;
  else await prisma.$executeRaw`UPDATE "RetentionLease" SET "owner" = NULL, "updatedAt" = NOW() WHERE "id" = ${RESTORE_HOLD_ID}`;
}
export const isRestoreHoldOn = async (prisma: any) => Boolean((await prisma.retentionLease.findUnique({ where: { id: RESTORE_HOLD_ID } }))?.owner);

export interface ReconcileReport { entriesInWindow: number; commentsInWindow: number; tombstonesRecreated: number; tombstonesRenewed: number; rowsReDeleted: { events: number; deliveries: number; replies: number } }
export interface VerifyReport { ok: boolean; missingTombstones: string[]; resurrected: string[]; chainError?: string }

type Window = { commentId: string; event: boolean; records: boolean; expiresAt: Date; ttlSeconds: number };

/** Entradas ainda dentro da janela de proteção (at + ttl > now), unificadas por comentário (mantém o maior prazo e a união das partes). */
function windowed(ledger: FileLedger, now: Date): { entries: number; byComment: Map<string, Window> } {
  const lines = ledger.read(); // também verifica a cadeia: adulteração lança
  const by = new Map<string, Window>(); let entries = 0;
  for (const l of lines) {
    const exp = new Date(new Date(l.at).getTime() + l.ttlSeconds * 1000);
    if (exp.getTime() <= now.getTime()) continue;
    entries++;
    for (const it of l.items) {
      const cur = by.get(it.commentId);
      by.set(it.commentId, { commentId: it.commentId, event: (cur?.event ?? false) || it.event, records: (cur?.records ?? false) || it.records, expiresAt: !cur || exp > cur.expiresAt ? exp : cur.expiresAt, ttlSeconds: l.ttlSeconds });
    }
  }
  return { entries, byComment: by };
}

export async function reconcileFromLedger(prisma: any, ledger: FileLedger, now = new Date()): Promise<ReconcileReport> {
  const { entries, byComment } = windowed(ledger, now);
  const rep: ReconcileReport = { entriesInWindow: entries, commentsInWindow: byComment.size, tombstonesRecreated: 0, tombstonesRenewed: 0, rowsReDeleted: { events: 0, deliveries: 0, replies: 0 } };
  for (const w of byComment.values()) {
    // TTL restante: renova até a data de expiração original (nunca encurta; GREATEST)
    const remaining = Math.max(1, Math.ceil((w.expiresAt.getTime() - now.getTime()) / 1000));
    const had = await prisma.idempotencyTombstone.findUnique({ where: { commentId: w.commentId } });
    const res = await prisma.$transaction((tx: any) => purgeCommentUnit(tx, w.commentId, { event: w.event, records: w.records }, remaining));
    if (!had) rep.tombstonesRecreated++; else rep.tombstonesRenewed++;
    rep.rowsReDeleted.events += res.events; rep.rowsReDeleted.deliveries += res.deliveries; rep.rowsReDeleted.replies += res.replies;
  }
  return rep;
}

export async function verifyReconciliation(prisma: any, ledger: FileLedger, now = new Date()): Promise<VerifyReport> {
  let byComment: Map<string, Window>;
  try { byComment = windowed(ledger, now).byComment; } catch (e) { return { ok: false, missingTombstones: [], resurrected: [], chainError: (e as Error).message }; }
  const missing: string[] = []; const resurrected: string[] = [];
  for (const w of byComment.values()) {
    const t = await prisma.idempotencyTombstone.findUnique({ where: { commentId: w.commentId } });
    if (!t || new Date(t.expiresAt).getTime() < w.expiresAt.getTime() - 1000) missing.push(w.commentId);
    const [e, d, p] = await Promise.all([w.event ? prisma.automationEvent.count({ where: { providerEventKey: `comment:${w.commentId}` } }) : 0, w.records ? prisma.messageDelivery.count({ where: { commentId: w.commentId } }) : 0, w.records ? prisma.publicReply.count({ where: { commentId: w.commentId } }) : 0]);
    if (e + d + p > 0) resurrected.push(w.commentId);
  }
  return { ok: missing.length === 0 && resurrected.length === 0, missingTombstones: missing, resurrected };
}

/** Fluxo completo e fail-closed: o bloqueio só é desligado se a verificação passar. */
export async function reconcileAndRelease(prisma: any, ledger: FileLedger, now = new Date()): Promise<{ reconcile: ReconcileReport | null; verify: VerifyReport; released: boolean }> {
  await setRestoreHold(prisma, true, "reconciliation");
  let reconcile: ReconcileReport | null = null; let verify: VerifyReport;
  try { reconcile = await reconcileFromLedger(prisma, ledger, now); verify = await verifyReconciliation(prisma, ledger, now); }
  catch (e) { verify = { ok: false, missingTombstones: [], resurrected: [], chainError: (e as Error).message }; }
  if (verify.ok) await setRestoreHold(prisma, false);
  return { reconcile, verify, released: verify.ok };
}
