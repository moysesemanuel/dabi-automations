import { describe, expect, it } from "vitest";
import { MetaApiError } from "./graph";
import { isInvalidTokenError } from "./credential-status";

const err = (meta?: { http?: number; code?: number; subcode?: number }) => new MetaApiError("erro de teste", meta);

describe("isInvalidTokenError (classificador central)", () => {
  it("190 sem subcódigo ou com 458/460/463/467 → credencial inválida (igual a antes)", () => {
    for (const subcode of [undefined, 458, 460, 463, 467]) expect(isInvalidTokenError(err({ http: 400, code: 190, subcode }))).toBe(true);
  });
  it("190/459 e 190/464 (ação do usuário) → NÃO é credencial inválida", () => {
    for (const subcode of [459, 464]) expect(isInvalidTokenError(err({ http: 400, code: 190, subcode }))).toBe(false);
  });
  it("200 (sem subcódigo), faixa 200–299, 10, 100, 4 e 17 → NÃO é credencial inválida", () => {
    for (const code of [200, 250, 299, 10, 100, 4, 17]) expect(isInvalidTokenError(err({ http: 400, code }))).toBe(false);
  });
  it("falha de rede (sem meta), 5xx e valores que não são MetaApiError → false", () => {
    expect(isInvalidTokenError(err())).toBe(false);
    expect(isInvalidTokenError(err({ http: 503 }))).toBe(false);
    expect(isInvalidTokenError(new Error("x"))).toBe(false);
    expect(isInvalidTokenError(null)).toBe(false);
    expect(isInvalidTokenError({ meta: { code: 190 } })).toBe(false);
  });
});
