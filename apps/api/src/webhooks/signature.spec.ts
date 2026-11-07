import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidMetaSignature } from "./signature";

const secret = "segredo-de-teste";
const body = Buffer.from('{"object":"instagram"}');
const sign = (b: Buffer, s: string) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");

describe("isValidMetaSignature", () => {
  it("aceita assinatura correta", () => expect(isValidMetaSignature(body, sign(body, secret), secret)).toBe(true));
  it("rejeita segredo errado", () => expect(isValidMetaSignature(body, sign(body, "outro"), secret)).toBe(false));
  it("rejeita corpo adulterado", () => expect(isValidMetaSignature(Buffer.from("x"), sign(body, secret), secret)).toBe(false));
  it("rejeita header ausente ou malformado", () => {
    expect(isValidMetaSignature(body, undefined, secret)).toBe(false);
    expect(isValidMetaSignature(body, "abc", secret)).toBe(false);
  });
});
