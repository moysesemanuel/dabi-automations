import { jobRetention } from "@dabi/contracts";

/**
 * Opções do Worker do BullMQ. A retenção dos registros de job é DESABILITADA por padrão (nenhuma remoção por idade) e só liga com
 * JOB_RETENTION_ENABLED=true e os dois prazos válidos; mesma função e mesmas variáveis da API. Configuração inválida é erro.
 */
export function workerQueueOptions(env: { REDIS_URL: string; JOB_RETENTION_ENABLED?: string; COMPLETED_JOB_MAX_AGE_SECONDS?: number; FAILED_JOB_MAX_AGE_SECONDS?: number }, extra: Record<string, unknown> = {}) {
  return {
    connection: { url: env.REDIS_URL },
    ...jobRetention({ enabled: env.JOB_RETENTION_ENABLED === "true", completedMaxAgeSeconds: env.COMPLETED_JOB_MAX_AGE_SECONDS, failedMaxAgeSeconds: env.FAILED_JOB_MAX_AGE_SECONDS }),
    ...extra,
  };
}
