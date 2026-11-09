import { describe, it, expect } from "vitest";
import { loadEnv } from "@dabi/config";
import { jobRetention } from "@dabi/contracts";
import { buildJobOptions } from "./webhooks/webhooks.service";

const BASE = { DATABASE_URL: "x", REDIS_URL: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "12345678", TOKEN_ENCRYPTION_KEY: "x", JWT_SECRET: "a".repeat(32) };

describe("retenção de jobs: configuração (loadEnv)", () => {
  it("por padrão: DESABILITADA e sem nenhum prazo", () => {
    const e = loadEnv(BASE);
    expect(e.JOB_RETENTION_ENABLED).toBe("false");
    expect(e.COMPLETED_JOB_MAX_AGE_SECONDS).toBeUndefined();
    expect(e.FAILED_JOB_MAX_AGE_SECONDS).toBeUndefined();
  });
  it("prazos sem habilitar não ligam nada (e não são erro)", () => {
    const e = loadEnv({ ...BASE, COMPLETED_JOB_MAX_AGE_SECONDS: "86400", FAILED_JOB_MAX_AGE_SECONDS: "604800" });
    expect(e.JOB_RETENTION_ENABLED).toBe("false");
  });
  it("habilitada SEM os prazos: erro de configuração (nunca assume um padrão)", () => {
    expect(() => loadEnv({ ...BASE, JOB_RETENTION_ENABLED: "true" })).toThrow(/não existe prazo padrão/);
    expect(() => loadEnv({ ...BASE, JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: "86400" })).toThrow(/FAILED_JOB_MAX_AGE_SECONDS/);
    expect(() => loadEnv({ ...BASE, JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: "", FAILED_JOB_MAX_AGE_SECONDS: "" })).toThrow(/obrigatória/);
  });
  it("habilitada com prazos válidos passa; fora da faixa ou não numérico, falha", () => {
    expect(loadEnv({ ...BASE, JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: "86400", FAILED_JOB_MAX_AGE_SECONDS: "604800" }).COMPLETED_JOB_MAX_AGE_SECONDS).toBe(86400);
    for (const bad of ["59", "0", "-5", "63072001", "abc", "1.5"]) expect(() => loadEnv({ ...BASE, JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: bad, FAILED_JOB_MAX_AGE_SECONDS: "86400" })).toThrow();
  });
  it("JOB_RETENTION_ENABLED só aceita 'true' ou 'false'", () => {
    for (const bad of ["1", "yes", "TRUE", "on"]) expect(() => loadEnv({ ...BASE, JOB_RETENTION_ENABLED: bad })).toThrow();
  });
});

describe("retenção de jobs: opções da API", () => {
  it("por padrão o job NÃO leva removeOnComplete nem removeOnFail; só attempts e backoff", () => {
    const o = buildJobOptions({});
    expect(o).toEqual({ attempts: 3, backoff: { type: "exponential", delay: 2000 } });
    expect("removeOnComplete" in o).toBe(false);
    expect("removeOnFail" in o).toBe(false);
  });
  it("prazos sem habilitação explícita são ignorados", () => {
    expect("removeOnComplete" in buildJobOptions({ COMPLETED_JOB_MAX_AGE_SECONDS: "86400", FAILED_JOB_MAX_AGE_SECONDS: "604800" })).toBe(false);
    expect("removeOnComplete" in buildJobOptions({ JOB_RETENTION_ENABLED: "false", COMPLETED_JOB_MAX_AGE_SECONDS: "86400", FAILED_JOB_MAX_AGE_SECONDS: "604800" })).toBe(false);
    expect("removeOnComplete" in buildJobOptions({ JOB_RETENTION_ENABLED: "TRUE", COMPLETED_JOB_MAX_AGE_SECONDS: "86400", FAILED_JOB_MAX_AGE_SECONDS: "604800" })).toBe(false);
  });
  it("habilitada de forma explícita: exatamente os prazos configurados, iguais aos que o worker usa", () => {
    const env = { JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: "172800", FAILED_JOB_MAX_AGE_SECONDS: "1209600" };
    const o = buildJobOptions(env);
    expect(o.removeOnComplete).toEqual({ age: 172_800 });
    expect(o.removeOnFail).toEqual({ age: 1_209_600 });
    expect({ removeOnComplete: o.removeOnComplete, removeOnFail: o.removeOnFail }).toEqual(jobRetention({ enabled: true, completedMaxAgeSeconds: 172_800, failedMaxAgeSeconds: 1_209_600 }));
  });
  it("habilitada com configuração inválida: ERRO (a API não inicia com retenção meio configurada)", () => {
    expect(() => buildJobOptions({ JOB_RETENTION_ENABLED: "true" })).toThrow(/obrigatória/);
    expect(() => buildJobOptions({ JOB_RETENTION_ENABLED: "true", COMPLETED_JOB_MAX_AGE_SECONDS: "10", FAILED_JOB_MAX_AGE_SECONDS: "86400" })).toThrow(/COMPLETED_JOB_MAX_AGE_SECONDS/);
  });
});
