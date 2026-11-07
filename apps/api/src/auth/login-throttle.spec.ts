import { describe, expect, it, beforeAll } from "vitest";
import { HttpException } from "@nestjs/common";
import { LoginThrottle, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP, type CounterStore } from "./login-throttle";

class MemoryStore implements CounterStore {
  m = new Map<string, number>();
  async incr(k: string) { const v = (this.m.get(k) ?? 0) + 1; this.m.set(k, v); return v; }
  async peek(k: string) { return { count: this.m.get(k) ?? 0, ttl: 600 }; }
  async del(k: string) { this.m.delete(k); }
}
const mk = (store: CounterStore = new MemoryStore()) => { const t = new LoginThrottle(); t.store = store; return { t, store }; };
const status = async (p: Promise<unknown>) => p.then(() => 200, (e: HttpException) => e.getStatus());

describe("LoginThrottle", () => {
  it("permite abaixo do limite e bloqueia (429) ao atingir o limite por e-mail", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) { expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(200); await t.recordFailure("1.1.1.1", "a@x.com"); }
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(429);
  });
  it("o limite por e-mail vale de qualquer IP (ataque distribuído) e ignora maiúsculas", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await t.recordFailure(`9.9.9.${i}`, i % 2 ? "A@X.COM" : "a@x.com");
    expect(await status(t.assertAllowed("8.8.8.8", " a@X.com "))).toBe(429);
  });
  it("outro e-mail não é afetado", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await t.recordFailure("1.1.1.1", "a@x.com");
    expect(await status(t.assertAllowed("2.2.2.2", "b@x.com"))).toBe(200);
  });
  it("limite por IP bloqueia varredura de vários e-mails", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_IP; i++) await t.recordFailure("5.5.5.5", `u${i}@x.com`);
    expect(await status(t.assertAllowed("5.5.5.5", "novo@x.com"))).toBe(429);
    expect(await status(t.assertAllowed("6.6.6.6", "novo@x.com"))).toBe(200);
  });
  it("login correto zera o contador do e-mail", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL - 1; i++) await t.recordFailure("1.1.1.1", "a@x.com");
    await t.recordSuccess("1.1.1.1", "a@x.com");
    await t.recordFailure("1.1.1.1", "a@x.com");
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(200);
  });
  it("a resposta 429 informa quanto esperar e não revela se o e-mail existe", async () => {
    const { t } = mk();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await t.recordFailure("1.1.1.1", "naoexiste@x.com");
    const e: HttpException = await t.assertAllowed("1.1.1.1", "naoexiste@x.com").catch((x) => x);
    expect(e.getStatus()).toBe(429);
    expect(JSON.stringify(e.getResponse())).toContain("retryAfter");
  });
  it("Redis fora do ar: não bloqueia ninguém e não derruba o login", async () => {
    const broken: CounterStore = { incr: async () => { throw new Error("down"); }, peek: async () => { throw new Error("down"); }, del: async () => { throw new Error("down"); } };
    const { t } = mk(broken);
    await expect(t.recordFailure("1.1.1.1", "a@x.com")).resolves.toBeUndefined();
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(200);
    await expect(t.recordSuccess("1.1.1.1", "a@x.com")).resolves.toBeUndefined();
  });
  it("chaves no Redis não contêm o e-mail em texto", async () => {
    const { t, store } = mk();
    await t.recordFailure("1.1.1.1", "pessoa@empresa.com");
    expect([...(store as MemoryStore).m.keys()].join(" ")).not.toContain("pessoa");
  });
});
