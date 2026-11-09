import { describe, it, expect } from "vitest";
import { jobRetention } from "@dabi/contracts";
import { workerQueueOptions } from "./queue-options";

describe("workerQueueOptions: retenção desabilitada por padrão", () => {
  it("sem configuração: só a conexão; nenhum removeOnComplete/removeOnFail", () => {
    const o: any = workerQueueOptions({ REDIS_URL: "redis://x" });
    expect(o).toEqual({ connection: { url: "redis://x" } });
    expect("removeOnComplete" in o).toBe(false);
    expect("removeOnFail" in o).toBe(false);
  });
  it("prazos sem JOB_RETENTION_ENABLED=true são ignorados", () => {
    for (const flag of [undefined, "false", "TRUE", "1"]) expect("removeOnComplete" in (workerQueueOptions({ REDIS_URL: "r", JOB_RETENTION_ENABLED: flag, COMPLETED_JOB_MAX_AGE_SECONDS: 86400, FAILED_JOB_MAX_AGE_SECONDS: 604800 }) as any)).toBe(false);
  });
  it("habilitada: usa os mesmos prazos e a mesma função da API", () => {
    const o: any = workerQueueOptions({ REDIS_URL: "r", JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: 172_800, FAILED_JOB_MAX_AGE_SECONDS: 1_209_600 });
    expect({ removeOnComplete: o.removeOnComplete, removeOnFail: o.removeOnFail }).toEqual(jobRetention({ enabled: true, completedMaxAgeSeconds: 172_800, failedMaxAgeSeconds: 1_209_600 }));
  });
  it("habilitada sem prazos ou com prazo inválido: erro", () => {
    expect(() => workerQueueOptions({ REDIS_URL: "r", JOB_RETENTION_ENABLED: "true" })).toThrow(/obrigatória/);
    expect(() => workerQueueOptions({ REDIS_URL: "r", JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: 5, FAILED_JOB_MAX_AGE_SECONDS: 86400 })).toThrow();
  });
  it("opções extras (testes) são preservadas", () => {
    expect((workerQueueOptions({ REDIS_URL: "r" }, { concurrency: 4 }) as any).concurrency).toBe(4);
  });
});
