import { describe, it, expect } from "vitest";
import { classifyMetaError, flagsCredentialForReconnect, type MetaErrorInput } from "./index";

const k = (e: MetaErrorInput) => classifyMetaError(e);

describe("classifyMetaError: código 190 (tabela oficial)", () => {
  it("subcódigos que exigem novo token → INVALID_CREDENTIAL", () => {
    for (const subcode of [458, 460, 463, 467, undefined]) expect(k({ http: 400, code: 190, subcode })).toBe("INVALID_CREDENTIAL");
  });
  it("459 (checkpoint) e 464 (usuário não confirmado) → USER_ACTION, NÃO credencial inválida", () => {
    for (const subcode of [459, 464]) expect(k({ http: 400, code: 190, subcode })).toBe("USER_ACTION");
  });
  it("492 (função de Página) → PERMISSION", () => expect(k({ http: 400, code: 190, subcode: 492 })).toBe("PERMISSION"));
  it("subcódigo 190 não listado → mantém INVALID_CREDENTIAL (a doc define 190 como token expirado/inválido)", () => expect(k({ code: 190, subcode: 999 })).toBe("INVALID_CREDENTIAL"));
});

describe("classifyMetaError: código 200 e permissões", () => {
  it("200 SEM subcódigo (o caso observado na elaniacosta.cake) → PERMISSION, nunca credencial inválida", () => {
    expect(k({ http: 400, code: 200 })).toBe("PERMISSION");
    expect(flagsCredentialForReconnect(k({ http: 400, code: 200 }))).toBe(false);
  });
  it("toda a faixa 200–299 e o código 10 → PERMISSION", () => {
    for (const code of [200, 201, 250, 299, 10]) expect(k({ http: 403, code })).toBe("PERMISSION");
    for (const code of [199, 300]) expect(k({ http: 400, code })).not.toBe("PERMISSION");
  });
  it("200 com qualquer subcódigo continua PERMISSION (a doc não lista subcódigos)", () => expect(k({ code: 200, subcode: 2108006 })).toBe("PERMISSION"));
});

describe("classifyMetaError: limites e falhas passageiras", () => {
  it("4, 17 (oficiais), 32, 613 (paridade com o worker), 368 (bloqueio temporário) e HTTP 429 → RATE_LIMIT", () => {
    for (const code of [4, 17, 32, 613, 368]) expect(k({ http: 400, code })).toBe("RATE_LIMIT");
    expect(k({ http: 429 })).toBe("RATE_LIMIT");
    expect(k({ http: 429, code: 100 })).toBe("RATE_LIMIT");
  });
  it("102: sem subcódigo é credencial inválida; com subcódigo é ambíguo (OTHER)", () => {
    expect(k({ code: 102 })).toBe("INVALID_CREDENTIAL");
    expect(k({ code: 102, subcode: 458 })).toBe("OTHER");
  });
  it("rede ou 5xx numa LEITURA → TRANSIENT", () => {
    expect(k({ network: true })).toBe("TRANSIENT");
    expect(k({ http: 500 })).toBe("TRANSIENT");
    expect(k({ http: 503, code: 2 })).toBe("TRANSIENT");
    expect(k({ network: true, operation: "read" })).toBe("TRANSIENT");
  });
  it("rede, timeout ou 5xx num ENVIO → UNKNOWN_OUTCOME (pode ter sido processado; nunca reenviar às cegas)", () => {
    expect(k({ network: true, operation: "send" })).toBe("UNKNOWN_OUTCOME");
    expect(k({ http: 500, operation: "send" })).toBe("UNKNOWN_OUTCOME");
    expect(k({ http: 502, code: 1, operation: "send" })).toBe("UNKNOWN_OUTCOME");
  });
  it("uma REJEIÇÃO explícita num envio NÃO é UNKNOWN_OUTCOME (a Meta recusou: nada foi enviado)", () => {
    expect(k({ http: 400, code: 190, operation: "send" })).toBe("INVALID_CREDENTIAL");
    expect(k({ http: 400, code: 200, operation: "send" })).toBe("PERMISSION");
    expect(k({ http: 429, operation: "send" })).toBe("RATE_LIMIT");
    expect(k({ http: 400, code: 100, subcode: 2534076, operation: "send" })).toBe("OTHER");
  });
});

describe("classifyMetaError: o que fica ambíguo é conservador", () => {
  it("sem código, sem rede e sem 5xx → OTHER", () => {
    expect(k({})).toBe("OTHER");
    expect(k({ http: 400 })).toBe("OTHER");
    expect(k({ http: 404 })).toBe("OTHER");
  });
  it("códigos não documentados nesta tabela (100, 1, 2, 80002) → OTHER, nunca reconexão", () => {
    for (const code of [100, 1, 2, 80002, 80006, 341, 506]) expect(flagsCredentialForReconnect(k({ http: 400, code }))).toBe(false);
  });
  it("code/subcode vindo como texto numérico é aceito", () => {
    expect(k({ code: "190" as any, subcode: "463" as any })).toBe("INVALID_CREDENTIAL");
    expect(k({ code: "190" as any, subcode: "459" as any })).toBe("USER_ACTION");
  });
  it("só INVALID_CREDENTIAL pede reconexão", () => {
    for (const kind of ["USER_ACTION", "PERMISSION", "RATE_LIMIT", "TRANSIENT", "UNKNOWN_OUTCOME", "OTHER"] as const) expect(flagsCredentialForReconnect(kind)).toBe(false);
    expect(flagsCredentialForReconnect("INVALID_CREDENTIAL")).toBe(true);
  });
});
