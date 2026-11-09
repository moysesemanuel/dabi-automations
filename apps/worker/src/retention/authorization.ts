import { AUTHORIZED_LIMITS } from "./rules";

/**
 * Autorização da execução. DRY_RUN é o padrão e nunca exclui nada. A execução REAL exige, ao mesmo tempo:
 * habilitação explícita, confirmação de ambiente + banco + data (UTC) + teto de linhas, teto de lote e de execução dentro dos
 * limites autorizados no código, retomada de HELD desligada e histórico de dry-run (decisão: 7 dias consecutivos).
 * Aumentar limites exige autorização específica e mudança de código revisada (AUTHORIZED_LIMITS).
 */
export interface RetentionRuntimeConfig {
  enabled: boolean;
  mode: "dry-run" | "execute";
  batchSize?: number;
  maxRowsPerRun?: number;
  /** Texto de confirmação: `<ambiente>|<banco>|<AAAA-MM-DD UTC>|<teto de linhas>` */
  confirm?: string;
  appEnv: string;
  dbName: string;
  resumeEnabled: boolean;
  /** Dias UTC consecutivos (terminando ontem ou hoje) com um dry-run concluído; vem do histórico em RetentionRun. */
  consecutiveDryRunDays: number;
}

export type RetentionPlan =
  | { ok: true; mode: "dry-run" | "execute"; batchSize: number; maxRows: number }
  | { ok: false; disabled?: boolean; problems: string[] };

export const REQUIRED_DRY_RUN_DAYS = 7;
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const confirmationFor = (appEnv: string, dbName: string, now: Date, maxRows: number) => `${appEnv}|${dbName}|${utcDay(now)}|${maxRows}`;

export function resolveRetentionPlan(c: RetentionRuntimeConfig, now: Date, opts: { requiredDryRunDays?: number } = {}): RetentionPlan {
  if (!c.enabled) return { ok: false, disabled: true, problems: ["retenção desabilitada (RETENTION_JOB_ENABLED não é true)"] };
  const batchSize = Math.min(c.batchSize ?? AUTHORIZED_LIMITS.batchMax, AUTHORIZED_LIMITS.batchMax);
  if (c.batchSize !== undefined && (!Number.isInteger(c.batchSize) || c.batchSize < 1)) return { ok: false, problems: ["RETENTION_BATCH_SIZE inválido"] };
  if (c.mode !== "execute") return { ok: true, mode: "dry-run", batchSize, maxRows: Math.min(c.maxRowsPerRun ?? AUTHORIZED_LIMITS.runMaxRows, AUTHORIZED_LIMITS.runMaxRows) };

  const p: string[] = [];
  if (c.batchSize !== undefined && c.batchSize > AUTHORIZED_LIMITS.batchMax) p.push(`lote acima do limite autorizado (${AUTHORIZED_LIMITS.batchMax}); aumentar exige autorização específica`);
  if (c.maxRowsPerRun === undefined) p.push("RETENTION_MAX_ROWS_PER_RUN é obrigatório na execução real (sem valor padrão)");
  else if (!Number.isInteger(c.maxRowsPerRun) || c.maxRowsPerRun < 1) p.push("RETENTION_MAX_ROWS_PER_RUN inválido");
  else if (c.maxRowsPerRun > AUTHORIZED_LIMITS.runMaxRows) p.push(`teto de linhas acima do limite autorizado (${AUTHORIZED_LIMITS.runMaxRows}); aumentar exige autorização específica`);
  if (c.resumeEnabled) p.push("a retomada de HELD está habilitada: a limpeza fica bloqueada");
  const need = opts.requiredDryRunDays ?? REQUIRED_DRY_RUN_DAYS;
  if (c.consecutiveDryRunDays < need) p.push(`faltam dias de dry-run: ${c.consecutiveDryRunDays} de ${need} consecutivos`);
  if (c.maxRowsPerRun !== undefined && Number.isInteger(c.maxRowsPerRun)) {
    const expected = confirmationFor(c.appEnv, c.dbName, now, c.maxRowsPerRun);
    if (!c.confirm) p.push(`confirmação ausente (esperada: ${expected})`);
    else if (c.confirm !== expected) p.push("confirmação não confere com ambiente, banco, data (UTC) e teto atuais");
  } else if (!c.confirm) p.push("confirmação ausente");
  return p.length ? { ok: false, problems: p } : { ok: true, mode: "execute", batchSize, maxRows: c.maxRowsPerRun! };
}
