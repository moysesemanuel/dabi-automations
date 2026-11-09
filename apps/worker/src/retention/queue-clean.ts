/**
 * Limpeza EXPLÍCITA de registros de job no BullMQ (a remoção por `age` do próprio BullMQ é preguiçosa e fica desabilitada).
 *
 * Só toca jobs CONCLUÍDOS ou COM FALHA da fila indicada, com `finishedOn` mais antigo que o prazo (é o critério do `clean` do BullMQ,
 * confirmado por teste). NUNCA toca wait, active, delayed, prioritized nem paused. Trava de segurança: o nome da fila esperado é
 * obrigatório e precisa bater; a fila real de desenvolvimento/produção só é aceita com `allowRealQueue` explícito (que os testes nunca usam).
 * Nunca usa FLUSHALL/FLUSHDB nem obliterate. Dry-run lista o que seria removido sem remover.
 */
export const QUEUE_CLEAN_LIMITS = { maxLimit: 100, minGraceMs: 3_600_000 } as const;
export const REAL_QUEUE_NAMES = ["comment-events"] as const;

export type CleanType = "completed" | "failed";
export interface QueueCleanOptions {
  expectedQueueName: string;
  graceMs: number;
  limit: number;
  types?: CleanType[];
  dryRun?: boolean;
  now?: () => number;
  /** Só para a fila REAL, e só com autorização específica. Os testes nunca ligam isto. */
  allowRealQueue?: boolean;
}
export interface QueueCleanReport { queue: string; dryRun: boolean; eligible: Record<CleanType, string[]>; removed: Record<CleanType, string[]>; untouchedBefore: Record<string, number>; untouchedAfter: Record<string, number> }

const UNTOUCHABLE = ["wait", "active", "delayed", "prioritized", "paused"] as const;

export function validateQueueClean(queueName: string, o: QueueCleanOptions): string[] {
  const p: string[] = [];
  if (queueName !== o.expectedQueueName) p.push(`a fila (${queueName}) não é a esperada (${o.expectedQueueName})`);
  if ((REAL_QUEUE_NAMES as readonly string[]).includes(queueName) && !o.allowRealQueue) p.push("fila real: exige autorização específica (allowRealQueue)");
  if (!Number.isFinite(o.graceMs) || o.graceMs < QUEUE_CLEAN_LIMITS.minGraceMs) p.push(`prazo mínimo de ${QUEUE_CLEAN_LIMITS.minGraceMs} ms`);
  if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > QUEUE_CLEAN_LIMITS.maxLimit) p.push(`limite deve ser inteiro entre 1 e ${QUEUE_CLEAN_LIMITS.maxLimit}`);
  for (const t of o.types ?? ["completed", "failed"]) if (t !== "completed" && t !== "failed") p.push(`tipo não permitido: ${String(t)}`);
  return p;
}

export async function cleanQueue(queue: any, o: QueueCleanOptions): Promise<QueueCleanReport> {
  const problems = validateQueueClean(queue.name, o);
  if (problems.length) throw new Error(`limpeza de fila recusada: ${problems.join("; ")}`);
  const types = o.types ?? (["completed", "failed"] as CleanType[]);
  const now = (o.now ?? Date.now)();
  const counts = async () => { const c = await queue.getJobCounts(...UNTOUCHABLE); return Object.fromEntries(UNTOUCHABLE.map((k) => [k, Number(c[k] ?? 0)])) as Record<string, number>; };
  const before = await counts();
  const report: QueueCleanReport = { queue: queue.name, dryRun: Boolean(o.dryRun), eligible: { completed: [], failed: [] }, removed: { completed: [], failed: [] }, untouchedBefore: before, untouchedAfter: before };
  let remaining = o.limit;
  for (const t of types) {
    if (remaining <= 0) break;
    // elegíveis por finishedOn (o mesmo critério do clean), os mais antigos primeiro, até o limite restante
    const jobs: any[] = await queue.getJobs([t], 0, 999, true);
    const eligible = jobs.filter((j) => typeof j.finishedOn === "number" && j.finishedOn < now - o.graceMs).sort((a, b) => a.finishedOn - b.finishedOn).slice(0, remaining).map((j) => String(j.id));
    report.eligible[t] = eligible;
    if (!o.dryRun && eligible.length) {
      const ids: string[] = await queue.clean(o.graceMs, remaining, t);
      report.removed[t] = ids.map(String);
      remaining -= ids.length;
    } else remaining -= eligible.length;
  }
  report.untouchedAfter = await counts();
  return report;
}
