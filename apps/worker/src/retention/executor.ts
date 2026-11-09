/**
 * Executor da retenção. DRY_RUN e EXECUTE usam a MESMA seleção e o MESMO planejamento: o relatório do dry-run é o que a execução faria.
 *
 * Garantias:
 *  - DRY_RUN: nenhuma alteração operacional (sem exclusão, sem mudança de estado, sem tombstone, sem remoção de job). O único efeito
 *    gravado é o registro administrativo da própria simulação em RetentionRun (sem dado pessoal).
 *  - EXECUTE: exige um plano autorizado (resolveRetentionPlan), a trava com fencing e a verificação de cada lote DENTRO da transação.
 *  - Fases por rodada: 1) transições de estado e encerramentos (needs_review); 2) exclusões. Um comentário nunca sofre as duas na mesma rodada.
 *  - Lote: no máximo `batchSize` linhas; teto total por execução `maxRows`; uma transação por lote; todas as linhas do comentário são
 *    travadas (FOR UPDATE SKIP LOCKED) e o estado é RE-AVALIADO sobre as linhas travadas; linha ocupada por outra execução é adiada.
 *  - Tombstone e exclusões na mesma transação (purgeCommentUnit). Falha em qualquer ponto desfaz o lote inteiro.
 *  - Se o registro durável de tombstones (ledger) falhar, as EXCLUSÕES são bloqueadas; transições e encerramentos seguem (não são definitivas).
 */
import { RETENTION_DEFAULTS, cutoff, planUnit, type UnitAction, type UnitSnapshot, type RecordSnap } from "./rules";
import { LeaseLostError, acquireLease, assertLeaseInTx, releaseLease, startHeartbeat, type LeaseHandle } from "./lease";
import { purgeCommentUnit } from "./purge";
import type { RetentionPlan } from "./authorization";
import type { DeliveryState } from "../delivery-expiry";

export interface LedgerItem { commentId: string; event: boolean; records: boolean }
export interface LedgerTransition { commentId: string; target: "dm" | "pub"; to: "CANCELED" | "UNKNOWN"; fromStatus: string; fromAttempts: number }
export interface LedgerEntry { runId: string; items: LedgerItem[]; ttlSeconds: number; transitions?: LedgerTransition[] }
/** Registro durável e independente do banco operacional. `intent` ANTES da transação, `done` DEPOIS do commit. */
export interface LedgerLike { intent(e: LedgerEntry): Promise<void>; done(e: LedgerEntry): Promise<void>; head?(): Promise<{ seq: number; hash: string } | null> }

export interface ExecDeps {
  prisma: any;
  now?: () => Date;
  owner?: string;
  leaseId?: string;
  leaseTtlSeconds?: number;
  heartbeatEveryMs?: number;
  ledger?: LedgerLike;
  isPaused?: () => Promise<boolean>;
  log?: (m: string) => void;
  limits?: Partial<typeof RETENTION_DEFAULTS>;
  /** SOMENTE TESTES: restringe a seleção a comentários cujo ID começa com o prefixo. Nunca usado em produção. */
  scopePrefix?: string;
  /** SOMENTE TESTES: ponto de injeção determinístico entre a seleção e a execução. */
  hooks?: { afterSelect?: (units: UnitSnapshot[]) => Promise<void> };
}

export interface RunCounts {
  scanned: number;
  actions: { none: number; defer: number; transition: number; close_review: number; overdue_review: number; purge: number };
  deferredReasons: Record<string, number>;
  rows: { transitionsCanceled: number; transitionsUnknown: number; closedReview: number; purgedEvents: number; purgedDeliveries: number; purgedReplies: number; tombstonesExpired: number; invitations: number; auditLogs: number; retentionRuns: number };
  skipped: { stale: number; busy: number; ledgerBlocked: number };
  capped: boolean;
}
export interface RunReport { runId: string; mode: "DRY_RUN" | "EXECUTE"; status: "COMPLETED" | "PARTIAL" | "FAILED" | "ABORTED"; abortReason?: string; counts: RunCounts; batches: number[]; sampleInternalIds: string[] }

const emptyCounts = (): RunCounts => ({
  scanned: 0, actions: { none: 0, defer: 0, transition: 0, close_review: 0, overdue_review: 0, purge: 0 }, deferredReasons: {},
  rows: { transitionsCanceled: 0, transitionsUnknown: 0, closedReview: 0, purgedEvents: 0, purgedDeliveries: 0, purgedReplies: 0, tombstonesExpired: 0, invitations: 0, auditLogs: 0, retentionRuns: 0 },
  skipped: { stale: 0, busy: 0, ledgerBlocked: 0 }, capped: false,
});

type Planned = { snap: UnitSnapshot; actions: UnitAction[]; ids: string[] };
const rowsOfAction = (a: UnitAction, snap: UnitSnapshot): number => {
  if (a.kind === "transition" || a.kind === "close_review") return 1;
  if (a.kind === "purge") return (a.parts.event && snap.event ? 1 : 0) + (a.parts.records ? (snap.dm ? 1 : 0) + (snap.pub ? 1 : 0) : 0);
  return 0;
};
const executable = (p: Planned) => p.actions.filter((a) => a.kind === "transition" || a.kind === "close_review" || a.kind === "purge");
const rowsOfUnit = (p: Planned) => executable(p).reduce((n, a) => n + rowsOfAction(a, p.snap), 0);

// ───────────────────────── seleção ─────────────────────────
const toSnap = (r: any): RecordSnap => ({ status: r.status as DeliveryState, attempts: r.attempts, createdAt: r.createdAt, updatedAt: r.updatedAt });

export async function selectUnits(prisma: any, now: Date, L: typeof RETENTION_DEFAULTS, take: number, scopePrefix?: string): Promise<{ units: UnitSnapshot[]; ids: Map<string, string[]> }> {
  const evCut = cutoff(now, L.eventMaxAgeMs), recCut = cutoff(now, L.recordMaxAgeMs), heldCut = cutoff(now, L.heldMaxAgeMs), stuckCut = cutoff(now, L.pendingStuckMs);
  const scopeC = scopePrefix ? { commentId: { startsWith: scopePrefix } } : {};
  const recWhere = { ...scopeC, OR: [{ updatedAt: { lt: recCut } }, { status: "PENDING", updatedAt: { lt: stuckCut } }, { status: "HELD", createdAt: { lt: heldCut } }] };
  const [evs, dms, pubs] = await Promise.all([
    prisma.automationEvent.findMany({ where: { receivedAt: { lt: evCut }, ...(scopePrefix ? { providerEventKey: { startsWith: `comment:${scopePrefix}` } } : {}) }, orderBy: { receivedAt: "asc" }, take, select: { providerEventKey: true } }),
    prisma.messageDelivery.findMany({ where: recWhere, orderBy: { updatedAt: "asc" }, take, select: { commentId: true } }),
    prisma.publicReply.findMany({ where: recWhere, orderBy: { updatedAt: "asc" }, take, select: { commentId: true } }),
  ]);
  const order: string[] = []; const seen = new Set<string>();
  for (const c of [...evs.map((e: any) => String(e.providerEventKey).replace(/^comment:/, "")), ...dms.map((d: any) => d.commentId), ...pubs.map((d: any) => d.commentId)]) if (!seen.has(c)) { seen.add(c); order.push(c); }
  const ids = order.slice(0, take);
  if (!ids.length) return { units: [], ids: new Map() };
  const [evAll, dmAll, pubAll] = await Promise.all([
    prisma.automationEvent.findMany({ where: { providerEventKey: { in: ids.map((c) => `comment:${c}`) } }, select: { id: true, providerEventKey: true, status: true, error: true, receivedAt: true } }),
    prisma.messageDelivery.findMany({ where: { commentId: { in: ids } } }),
    prisma.publicReply.findMany({ where: { commentId: { in: ids } } }),
  ]);
  const idMap = new Map<string, string[]>();
  const units = ids.map((c): UnitSnapshot => {
    const e = evAll.find((x: any) => x.providerEventKey === `comment:${c}`); const d = dmAll.find((x: any) => x.commentId === c); const p = pubAll.find((x: any) => x.commentId === c);
    idMap.set(c, [e?.id, d?.id, p?.id].filter(Boolean));
    return { commentId: c, event: e ? { status: e.status, error: e.error, receivedAt: e.receivedAt } : null, dm: d ? toSnap(d) : null, pub: p ? toSnap(p) : null };
  });
  return { units, ids: idMap };
}

// ───────────────────────── lote ─────────────────────────
async function lockAndLoad(tx: any, cid: string): Promise<{ snap: UnitSnapshot; busy: boolean }> {
  const key = `comment:${cid}`;
  const [lEv, lDm, lPub]: { id: string }[][] = await Promise.all([
    tx.$queryRaw`SELECT "id" FROM "AutomationEvent" WHERE "providerEventKey" = ${key} FOR UPDATE SKIP LOCKED`,
    tx.$queryRaw`SELECT "id" FROM "MessageDelivery" WHERE "commentId" = ${cid} FOR UPDATE SKIP LOCKED`,
    tx.$queryRaw`SELECT "id" FROM "PublicReply" WHERE "commentId" = ${cid} FOR UPDATE SKIP LOCKED`,
  ]);
  const [cEv, cDm, cPub] = await Promise.all([tx.automationEvent.count({ where: { providerEventKey: key } }), tx.messageDelivery.count({ where: { commentId: cid } }), tx.publicReply.count({ where: { commentId: cid } })]);
  const busy = lEv.length < cEv || lDm.length < cDm || lPub.length < cPub;
  if (busy) return { snap: { commentId: cid }, busy };
  const [e, d, p] = await Promise.all([tx.automationEvent.findUnique({ where: { providerEventKey: key } }), tx.messageDelivery.findUnique({ where: { commentId: cid } }), tx.publicReply.findUnique({ where: { commentId: cid } })]);
  return { snap: { commentId: cid, event: e ? { status: e.status, error: e.error, receivedAt: e.receivedAt } : null, dm: d ? toSnap(d) : null, pub: p ? toSnap(p) : null }, busy };
}

export async function runRetention(deps: ExecDeps, plan: Extract<RetentionPlan, { ok: true }>): Promise<RunReport> {
  const { prisma } = deps;
  const nowFn = deps.now ?? (() => new Date());
  const L = { ...RETENTION_DEFAULTS, ...(deps.limits ?? {}) } as typeof RETENTION_DEFAULTS;
  const execute = plan.mode === "execute";
  const log = deps.log ?? (() => {});
  const counts = emptyCounts();
  const batches: number[] = [];
  const now0 = nowFn();
  const run = await prisma.retentionRun.create({ data: { mode: execute ? "EXECUTE" : "DRY_RUN", limits: { batchSize: plan.batchSize, maxRows: plan.maxRows } } });
  const finish = async (status: RunReport["status"], abortReason?: string, extra: Partial<{ leaseEpoch: number }> = {}): Promise<RunReport> => {
    const ledgerHead = execute && deps.ledger?.head ? await deps.ledger.head().catch(() => null) : null;
    await prisma.retentionRun.update({ where: { id: run.id }, data: { status, finishedAt: new Date(), counts: { ...counts, ...(ledgerHead ? { ledgerHead } : {}) } as any, error: abortReason ?? null, ...extra } });
    if (execute) await prisma.auditLog.create({ data: { action: "retention.run", entityType: "RetentionRun", entityId: run.id, metadata: { status, rows: counts.rows, skipped: counts.skipped } as any } }).catch(() => {});
    return { runId: run.id, mode: execute ? "EXECUTE" : "DRY_RUN", status, abortReason, counts, batches, sampleInternalIds: samples };
  };
  const samples: string[] = [];

  let lease: LeaseHandle | null = null; let hb: { stop: () => void } | null = null; let lost = "";
  try {
    if (execute) {
      // Depois de uma RESTAURAÇÃO o banco pode estar atrás do registro durável: sem reconciliar, tombstones criados depois do backup
      // não existem. Recusa executar até a reconciliação (ver restore.ts). O gate compara o head do ledger com o último head gravado.
      if (deps.ledger?.head) {
        const head = await deps.ledger.head();
        const last = await prisma.retentionRun.findFirst({ where: { mode: "EXECUTE", status: { in: ["COMPLETED", "PARTIAL"] } }, orderBy: { startedAt: "desc" }, select: { counts: true } });
        const known = Number((last?.counts as any)?.ledgerHead?.seq ?? 0);
        if (head && head.seq > known) return await finish("ABORTED", `o registro durável (seq ${head.seq}) está à frente do banco (seq ${known}): reconciliar após restauração antes de executar`);
      }
      lease = await acquireLease(prisma, deps.owner ?? `retention-${process.pid}`, deps.leaseTtlSeconds ?? 60, deps.leaseId);
      if (!lease) return await finish("ABORTED", "outra execução da retenção está ativa (trava não adquirida)");
      hb = startHeartbeat(prisma, lease, deps.leaseTtlSeconds ?? 60, (why) => { lost = why; }, deps.heartbeatEveryMs);
    }
    // ── seleção e planejamento (comum aos dois modos)
    const take = Math.min(plan.maxRows * 4 + 20, 500);
    const { units, ids } = await selectUnits(prisma, now0, L, take, deps.scopePrefix);
    if (deps.hooks?.afterSelect) await deps.hooks.afterSelect(units);
    counts.scanned = units.length;
    const planned: Planned[] = units.map((snap) => ({ snap, actions: planUnit(snap, now0, L), ids: ids.get(snap.commentId) ?? [] }));
    for (const p of planned) for (const a of p.actions) {
      counts.actions[a.kind]++;
      if (a.kind === "defer") counts.deferredReasons[a.reason] = (counts.deferredReasons[a.reason] ?? 0) + 1;
    }

    // ── orçamento de linhas, fases e lotes (as fases: 1 = transições/encerramentos, 2 = exclusões)
    let budget = plan.maxRows;
    const takeWithin = (list: Planned[]): Planned[] => { const out: Planned[] = []; for (const p of list) { const r = rowsOfUnit(p); if (r === 0) continue; if (r > budget) { counts.capped = true; break; } budget -= r; out.push(p); } return out; };
    const phase1 = takeWithin(planned.filter((p) => p.actions.some((a) => a.kind === "transition" || a.kind === "close_review")));
    const phase2 = takeWithin(planned.filter((p) => p.actions.some((a) => a.kind === "purge")));
    const toBatches = (list: Planned[]): Planned[][] => { const out: Planned[][] = []; let cur: Planned[] = []; let rows = 0; for (const p of list) { const r = rowsOfUnit(p); if (cur.length && rows + r > plan.batchSize) { out.push(cur); cur = []; rows = 0; } cur.push(p); rows += r; } if (cur.length) out.push(cur); return out; };

    const tally = (p: Planned) => { for (const a of p.actions) {
      if (a.kind === "transition") { if (a.to === "CANCELED") counts.rows.transitionsCanceled++; else counts.rows.transitionsUnknown++; }
      else if (a.kind === "close_review") counts.rows.closedReview++;
      else if (a.kind === "purge") { if (a.parts.event && p.snap.event) counts.rows.purgedEvents++; if (a.parts.records) { if (p.snap.dm) counts.rows.purgedDeliveries++; if (p.snap.pub) counts.rows.purgedReplies++; } }
    } };

    if (!execute) {
      // DRY_RUN: apenas contabiliza o que a execução faria (mesmos limites). Nada é alterado.
      for (const p of [...phase1, ...phase2]) { tally(p); if (samples.length < 5) samples.push(...p.ids.slice(0, 1)); }
      for (const b of toBatches([...phase1, ...phase2])) batches.push(b.reduce((n, p) => n + rowsOfUnit(p), 0));
      await countSimple(prisma, now0, L, counts, () => budget, (n) => { budget -= n; });
      return await finish("COMPLETED");
    }

    // ── EXECUTE
    const runBatch = async (batch: Planned[], purge: boolean): Promise<boolean> => {
      if (deps.isPaused && (await deps.isPaused())) { counts.skipped.stale += batch.length; return false; }
      if (lost) return false;
      if (purge && deps.ledger) {
        try { await deps.ledger.intent({ runId: run.id, ttlSeconds: L.tombstoneTtlSeconds, items: batch.flatMap((p) => p.actions.filter((a) => a.kind === "purge").map((a) => ({ commentId: p.snap.commentId, event: (a as any).parts.event && Boolean(p.snap.event), records: (a as any).parts.records }))) }); }
        catch { counts.skipped.ledgerBlocked += batch.length; return true; } // registro durável indisponível: NÃO exclui (continua para outras fases)
      }
      const tx = await prisma.$transaction(async (t: any) => {
        await assertLeaseInTx(t, lease!);
        let rows = 0; const done: LedgerItem[] = []; const trans: LedgerTransition[] = []; const local = emptyCounts();
        for (const p of batch) {
          const fresh = await lockAndLoad(t, p.snap.commentId);
          if (fresh.busy) { local.skipped.busy++; continue; }
          const fa = planUnit(fresh.snap, nowFn(), L).filter((a) => a.kind === "transition" || a.kind === "close_review" || a.kind === "purge");
          const wanted = p.actions.filter((a) => a.kind === "transition" || a.kind === "close_review" || a.kind === "purge");
          if (fa.length !== wanted.length || fa.some((a, i) => a.kind !== wanted[i].kind)) { local.skipped.stale++; continue; } // o estado mudou desde a seleção
          for (const a of fa) {
            if (a.kind === "transition") {
              const model = a.target === "dm" ? "messageDelivery" : "publicReply"; const r = a.target === "dm" ? fresh.snap.dm! : fresh.snap.pub!;
              const upd = await t[model].updateMany({ where: { commentId: p.snap.commentId, status: r.status, attempts: r.attempts }, data: { status: a.to, error: a.to === "CANCELED" ? "retention.canceled" : "retention.unknown_after_stall" } });
              if (upd.count === 1) { rows++; trans.push({ commentId: p.snap.commentId, target: a.target, to: a.to, fromStatus: r.status, fromAttempts: r.attempts }); if (a.to === "CANCELED") local.rows.transitionsCanceled++; else local.rows.transitionsUnknown++; } else local.skipped.stale++;
            } else if (a.kind === "close_review") {
              const upd = await t.automationEvent.updateMany({ where: { providerEventKey: `comment:${p.snap.commentId}`, status: "RECEIVED", error: { startsWith: "needs_review." } }, data: { status: "IGNORED", error: "dropped.review_expired" } });
              if (upd.count === 1) { rows++; local.rows.closedReview++; } else local.skipped.stale++;
            } else {
              const res = await purgeCommentUnit(t, p.snap.commentId, a.parts, L.tombstoneTtlSeconds);
              rows += res.events + res.deliveries + res.replies; local.rows.purgedEvents += res.events; local.rows.purgedDeliveries += res.deliveries; local.rows.purgedReplies += res.replies; done.push({ commentId: p.snap.commentId, event: a.parts.event && res.events > 0, records: a.parts.records });
            }
          }
        }
        return { rows, done, trans, local };
      }, { timeout: 30_000, maxWait: 5_000 });
      batches.push(tx.rows);
      for (const k of Object.keys(tx.local.rows) as (keyof RunCounts["rows"])[]) counts.rows[k] += tx.local.rows[k];
      counts.skipped.busy += tx.local.skipped.busy; counts.skipped.stale += tx.local.skipped.stale;
      // Transições de estado também vão ao registro durável: uma restauração traz de volta o estado ANTERIOR (ex.: HELD que já foi cancelada).
      if (!purge && deps.ledger && tx.trans.length) await deps.ledger.done({ runId: run.id, items: [], transitions: tx.trans, ttlSeconds: L.tombstoneTtlSeconds }).catch(() => { counts.skipped.ledgerBlocked += 0; });
      if (purge && deps.ledger && tx.done.length) await deps.ledger.done({ runId: run.id, items: tx.done, ttlSeconds: L.tombstoneTtlSeconds }).catch(() => { counts.skipped.ledgerBlocked += 0; });
      for (const p of batch) if (samples.length < 5) samples.push(...p.ids.slice(0, 1));
      return true;
    };
    for (const b of toBatches(phase1)) { if (!(await runBatch(b, false))) break; }
    for (const b of toBatches(phase2)) { if (!(await runBatch(b, true))) break; }
    if (!lost) await purgeSimple(prisma, lease!, now0, L, counts, plan.batchSize, () => budget, (n) => { budget -= n; }, batches, () => lost);
    if (lost) return await finish("PARTIAL", `trava perdida durante a execução: ${lost}`, { leaseEpoch: lease!.epoch });
    return await finish("COMPLETED", undefined, { leaseEpoch: lease!.epoch });
  } catch (e) {
    const lostLease = e instanceof LeaseLostError;
    log(`retenção interrompida: ${(e as Error).name}`);
    return await finish(lostLease ? "ABORTED" : "FAILED", lostLease ? "trava perdida ou expirada antes de um lote" : `erro: ${(e as Error).name}`, lease ? { leaseEpoch: lease.epoch } : {});
  } finally {
    hb?.stop();
    if (lease) await releaseLease(prisma, lease).catch(() => {});
  }
}

// ───────────────────────── demais categorias (tombstones expirados, convites, auditoria, execuções antigas) ─────────────────────────
type Cat = { key: keyof RunCounts["rows"]; model: string; where: (now: Date, L: typeof RETENTION_DEFAULTS) => any };
const CATS: Cat[] = [
  { key: "tombstonesExpired", model: "idempotencyTombstone", where: (now) => ({ expiresAt: { lt: now } }) },
  { key: "invitations", model: "invitation", where: (now, L) => { const c = cutoff(now, L.invitationMs); return { OR: [{ expiresAt: { lt: c } }, { acceptedAt: { lt: c } }, { revokedAt: { lt: c } }] }; } },
  { key: "auditLogs", model: "auditLog", where: (now, L) => ({ createdAt: { lt: cutoff(now, L.auditMs) } }) },
  { key: "retentionRuns", model: "retentionRun", where: (now, L) => ({ startedAt: { lt: cutoff(now, L.retentionRunMs) }, status: { not: "RUNNING" } }) },
];

async function countSimple(prisma: any, now: Date, L: typeof RETENTION_DEFAULTS, counts: RunCounts, budget: () => number, spend: (n: number) => void) {
  for (const c of CATS) { const n = Math.min(await prisma[c.model].count({ where: c.where(now, L) }), Math.max(budget(), 0)); counts.rows[c.key] += n; spend(n); }
}

async function purgeSimple(prisma: any, lease: LeaseHandle, now: Date, L: typeof RETENTION_DEFAULTS, counts: RunCounts, batchSize: number, budget: () => number, spend: (n: number) => void, batches: number[], isLost: () => string) {
  for (const c of CATS) {
    while (budget() > 0 && !isLost()) {
      const take = Math.min(batchSize, budget());
      const rows: { id: string }[] = await prisma[c.model].findMany({ where: c.where(now, L), orderBy: { id: "asc" }, take, select: { id: true } });
      if (!rows.length) break;
      const n: number = await prisma.$transaction(async (t: any) => {
        await assertLeaseInTx(t, lease);
        // o predicado é REAVALIADO no próprio DELETE: linha que deixou de ser elegível entre a seleção e a exclusão não é apagada
        return (await t[c.model].deleteMany({ where: { AND: [{ id: { in: rows.map((r) => r.id) } }, c.where(now, L)] } })).count;
      }, { timeout: 30_000 });
      counts.rows[c.key] += n; spend(n); batches.push(n);
      if (n === 0) break;
    }
  }
}
