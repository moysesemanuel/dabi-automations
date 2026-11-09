import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { HMAC_KEY_VERSION, _resetHmacStateForTests, auditEmailMetadata, productionKeyProblems, rateLimitDigest } from "./hmac";

const K1 = "a".repeat(32), K2 = "b".repeat(32);
beforeEach(() => _resetHmacStateForTests());

describe("auditEmailMetadata", () => {
  it("com chave: só um HMAC versionado, determinístico e sem o e-mail", () => {
    const m = auditEmailMetadata("Pessoa@Exemplo.com", { AUDIT_HMAC_KEY: K1 });
    expect(Object.keys(m)).toEqual(["emailHmac"]);
    expect(m.emailHmac).toMatch(new RegExp(`^${HMAC_KEY_VERSION}:[0-9a-f]{64}$`));
    expect(JSON.stringify(m).toLowerCase()).not.toContain("pessoa");
    expect(auditEmailMetadata("  pessoa@exemplo.COM ", { AUDIT_HMAC_KEY: K1 })).toEqual(m); // normaliza maiúsculas e espaços
  });

  it("NÃO é SHA-256 simples: quem conhece o e-mail não reproduz o valor sem a chave", () => {
    const simples = createHash("sha256").update("pessoa@exemplo.com").digest("hex");
    const m = auditEmailMetadata("pessoa@exemplo.com", { AUDIT_HMAC_KEY: K1 });
    expect(m.emailHmac).not.toContain(simples);
    expect(m.emailHmac).not.toContain(createHash("sha256").update("audit-email:pessoa@exemplo.com").digest("hex"));
  });

  it("chaves diferentes dão valores diferentes; e-mails diferentes também", () => {
    expect(auditEmailMetadata("a@x.com", { AUDIT_HMAC_KEY: K1 })).not.toEqual(auditEmailMetadata("a@x.com", { AUDIT_HMAC_KEY: K2 }));
    expect(auditEmailMetadata("a@x.com", { AUDIT_HMAC_KEY: K1 })).not.toEqual(auditEmailMetadata("b@x.com", { AUDIT_HMAC_KEY: K1 }));
  });

  it("sem chave fora de produção: NENHUM identificador derivado do e-mail", () => {
    expect(auditEmailMetadata("a@x.com", {})).toEqual({});
    expect(auditEmailMetadata("a@x.com", { NODE_ENV: "development" })).toEqual({});
  });

  it("sem chave em produção: erro (fail-closed), nunca grava", () => {
    expect(() => auditEmailMetadata("a@x.com", { NODE_ENV: "production" })).toThrow(/AUDIT_HMAC_KEY/);
  });
});

describe("rateLimitDigest", () => {
  it("determinístico, normalizado, 32 hex, e sem e-mail nem IP em texto", () => {
    const a = rateLimitDigest("email", " A@X.com ", { RATE_LIMIT_HMAC_KEY: K1 });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(rateLimitDigest("email", "a@x.com", { RATE_LIMIT_HMAC_KEY: K1 }));
    expect(rateLimitDigest("ip", "203.0.113.7", { RATE_LIMIT_HMAC_KEY: K1 })).not.toContain("203");
  });

  it("e-mail e IP com o mesmo texto geram valores diferentes (finalidades separadas)", () => {
    expect(rateLimitDigest("email", "x", { RATE_LIMIT_HMAC_KEY: K1 })).not.toBe(rateLimitDigest("ip", "x", { RATE_LIMIT_HMAC_KEY: K1 }));
  });

  it("é independente da chave de auditoria: a mesma entrada dá valores diferentes e trocar uma chave não afeta a outra", () => {
    const env = { AUDIT_HMAC_KEY: K1, RATE_LIMIT_HMAC_KEY: K2 };
    expect(rateLimitDigest("email", "a@x.com", env)).not.toBe(auditEmailMetadata("a@x.com", env).emailHmac!.split(":")[1].slice(0, 32));
    expect(rateLimitDigest("email", "a@x.com", { ...env, AUDIT_HMAC_KEY: "z".repeat(32) })).toBe(rateLimitDigest("email", "a@x.com", env));
  });

  it("sem chave fora de produção: o limitador continua funcionando (chave temporária estável no processo) e avisa uma vez", () => {
    const avisos: string[] = [];
    const a = rateLimitDigest("email", "a@x.com", {}, (m) => avisos.push(m));
    const b = rateLimitDigest("email", "a@x.com", {}, (m) => avisos.push(m));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(b);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/apenas desenvolvimento/);
  });

  it("sem chave em produção: erro, não há como desativar o limitador por omissão de configuração", () => {
    expect(() => rateLimitDigest("email", "a@x.com", { NODE_ENV: "production" })).toThrow(/RATE_LIMIT_HMAC_KEY/);
  });
});

describe("productionKeyProblems", () => {
  const ok = { NODE_ENV: "production", AUDIT_HMAC_KEY: K1, RATE_LIMIT_HMAC_KEY: K2, JWT_SECRET: "j".repeat(40), TOKEN_ENCRYPTION_KEY: "t".repeat(44) };
  it("fora de produção não exige nada", () => expect(productionKeyProblems({})).toEqual([]));
  it("produção correta: sem problemas", () => expect(productionKeyProblems(ok)).toEqual([]));
  it("exige as duas chaves e o tamanho mínimo", () => {
    expect(productionKeyProblems({ ...ok, AUDIT_HMAC_KEY: undefined })).toEqual(["AUDIT_HMAC_KEY é obrigatória em produção"]);
    expect(productionKeyProblems({ ...ok, RATE_LIMIT_HMAC_KEY: "curta" })).toEqual(["RATE_LIMIT_HMAC_KEY deve ter ao menos 32 caracteres"]);
  });
  it("exige independência entre as quatro chaves", () => {
    expect(productionKeyProblems({ ...ok, RATE_LIMIT_HMAC_KEY: K1 }).join()).toMatch(/AUDIT_HMAC_KEY e RATE_LIMIT_HMAC_KEY não podem ser iguais/);
    expect(productionKeyProblems({ ...ok, AUDIT_HMAC_KEY: ok.JWT_SECRET }).join()).toMatch(/AUDIT_HMAC_KEY e JWT_SECRET/);
    expect(productionKeyProblems({ ...ok, RATE_LIMIT_HMAC_KEY: ok.TOKEN_ENCRYPTION_KEY }).join()).toMatch(/RATE_LIMIT_HMAC_KEY e TOKEN_ENCRYPTION_KEY/);
  });
});
