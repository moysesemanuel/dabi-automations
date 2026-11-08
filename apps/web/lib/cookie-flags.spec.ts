import { describe, expect, it } from "vitest";
import { shouldUseSecureCookie } from "./cookie-flags";

describe("shouldUseSecureCookie", () => {
  it("produção é sempre Secure", () => expect(shouldUseSecureCookie("production", null)).toBe(true));
  it("dev atrás de túnel HTTPS (X-Forwarded-Proto: https) é Secure", () => {
    expect(shouldUseSecureCookie("development", "https")).toBe(true);
    expect(shouldUseSecureCookie("development", "https, http")).toBe(true);
  });
  it("dev em http://localhost não é Secure (o navegador descartaria em alguns casos)", () => {
    expect(shouldUseSecureCookie("development", null)).toBe(false);
    expect(shouldUseSecureCookie("development", "http")).toBe(false);
  });
});
