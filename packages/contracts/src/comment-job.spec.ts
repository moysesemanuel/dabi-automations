import { describe, it, expect } from "vitest";
import { parseCommentEventJob, commentEventJobMinimalSchema } from "./index";

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
