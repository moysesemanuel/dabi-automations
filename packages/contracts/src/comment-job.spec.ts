import { describe, it, expect } from "vitest";
import { parseCommentEventJob, commentEventJobMinimalSchema, jobRetention } from "./index";

const legacy = { eventId: "e1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: "CAFÉ", fromId: "u1" };

describe("parseCommentEventJob", () => {
  it("reconhece o formato legado completo (com e sem fromId)", () => {
    expect(parseCommentEventJob(legacy)).toEqual({ kind: "legacy", job: legacy });
    const { fromId, ...semFrom } = legacy; void fromId;
    expect(parseCommentEventJob(semFrom).kind).toBe("legacy");
  });

  it("reconhece o formato mínimo { eventId }", () => {
    expect(parseCommentEventJob({ eventId: "e1" })).toEqual({ kind: "minimal", job: { eventId: "e1" } });
  });

  it("rejeita o formato mínimo com qualquer campo extra (dado pessoal não volta ao job por descuido)", () => {
    for (const extra of [{ text: "x" }, { fromId: "u" }, { igAccountId: "ig" }, { payload: {} }, { username: "a" }]) {
      expect(parseCommentEventJob({ eventId: "e1", ...extra })).toEqual({ kind: "invalid", reason: "minimal_shape_invalid" });
    }
  });

  it("legado incompleto (tem commentId, falta campo obrigatório) é inválido, não mínimo", () => {
    expect(parseCommentEventJob({ eventId: "e1", commentId: "c1" })).toEqual({ kind: "invalid", reason: "legacy_shape_invalid" });
  });

  it("rejeita entradas que não são objeto e eventId vazio ou ausente", () => {
    for (const bad of [null, undefined, "x", 1, true, [], [{ eventId: "e" }]]) expect(parseCommentEventJob(bad)).toEqual({ kind: "invalid", reason: "not_object" });
    expect(parseCommentEventJob({}).kind).toBe("invalid");
    expect(parseCommentEventJob({ eventId: "" }).kind).toBe("invalid");
    expect(parseCommentEventJob({ eventId: 5 }).kind).toBe("invalid");
  });

  it("o resultado inválido NUNCA repete o conteúdo recebido (nem texto, nem ids)", () => {
    const r = parseCommentEventJob({ eventId: "e1", commentId: "SEGREDO-123", text: "texto do comentarista" });
    expect(JSON.stringify(r)).not.toMatch(/SEGREDO|comentarista|e1/);
  });

  it("o schema mínimo é estrito", () => {
    expect(commentEventJobMinimalSchema.safeParse({ eventId: "e", extra: 1 }).success).toBe(false);
  });
});

describe("jobRetention: desabilitada por padrão", () => {
  it("sem configuração, ou sem habilitação explícita, NÃO devolve nenhuma opção de remoção", () => {
    expect(jobRetention()).toEqual({});
    expect(jobRetention({})).toEqual({});
    expect(jobRetention({ completedMaxAgeSeconds: 86_400, failedMaxAgeSeconds: 604_800 })).toEqual({}); // prazos sem habilitar: ignorados
    for (const enabled of [false, undefined, "true" as any, 1 as any, "yes" as any, null as any]) expect(jobRetention({ enabled, completedMaxAgeSeconds: 86_400, failedMaxAgeSeconds: 604_800 })).toEqual({});
  });
  it("habilitada de forma explícita, usa EXATAMENTE os prazos informados (sem 'count', sem padrão)", () => {
    expect(jobRetention({ enabled: true, completedMaxAgeSeconds: 86_400, failedMaxAgeSeconds: 604_800 })).toEqual({ removeOnComplete: { age: 86_400 }, removeOnFail: { age: 604_800 } });
  });
  it("habilitada SEM os dois prazos é erro: a ausência de configuração nunca cria um prazo", () => {
    expect(() => jobRetention({ enabled: true })).toThrow(/obrigatória.*não existe prazo padrão/);
    expect(() => jobRetention({ enabled: true, completedMaxAgeSeconds: 86_400 })).toThrow(/FAILED_JOB_MAX_AGE_SECONDS é obrigatória/);
    expect(() => jobRetention({ enabled: true, failedMaxAgeSeconds: 86_400 })).toThrow(/COMPLETED_JOB_MAX_AGE_SECONDS é obrigatória/);
  });
  it("valida os valores: inteiros entre 1 hora e 2 anos", () => {
    const base = { enabled: true as const, completedMaxAgeSeconds: 86_400, failedMaxAgeSeconds: 86_400 };
    for (const bad of [0, -1, 59, 3_599, 63_072_001, 1.5, NaN, Infinity, "86400" as any]) {
      expect(() => jobRetention({ ...base, completedMaxAgeSeconds: bad })).toThrow(/COMPLETED_JOB_MAX_AGE_SECONDS/);
      expect(() => jobRetention({ ...base, failedMaxAgeSeconds: bad })).toThrow(/FAILED_JOB_MAX_AGE_SECONDS/);
    }
    expect(() => jobRetention({ ...base, completedMaxAgeSeconds: 3_600, failedMaxAgeSeconds: 63_072_000 })).not.toThrow();
  });
});
