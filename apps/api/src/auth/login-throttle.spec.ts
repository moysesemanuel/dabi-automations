import { describe, expect, it, beforeAll } from "vitest";
import { HttpException } from "@nestjs/common";
import { LocalCounterStore, LoginThrottle, MAX_FAILURES_PER_EMAIL, MAX_FAILURES_PER_IP, type CounterStore } from "./login-throttle";

class MemoryStore implements CounterStore {
  m = new Map<string, number>();
  async incr(k: string) { const v = (this.m.get(k) ?? 0) + 1; this.m.set(k, v); return v; }
  async peek(k: string) { return { count: this.m.get(k) ?? 0, ttl: 600 }; }
  async del(k: string) { this.m.delete(k); }
}
const mk = (store: CounterStore = new MemoryStore(), mode?: "local" | "closed") => { const t = new LoginThrottle(); t.store = store; t.mode = mode; return { t, store }; };
const broken: CounterStore = { incr: async () => { throw new Error("down"); }, peek: async () => { throw new Error("down"); }, del: async () => { throw new Error("down"); } };
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
  it("Redis fora do ar (modo local): continua bloqueando por contador em memória, com os mesmos limites", async () => {
    const { t } = mk(broken, "local");
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) { expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(200); await t.recordFailure("1.1.1.1", "a@x.com"); }
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(429);
    expect(await status(t.assertAllowed("2.2.2.2", "b@x.com"))).toBe(200); // outro e-mail segue livre
  });
  it("falhas registradas com o Redis saudável contam se ele cair depois", async () => {
    const live = new MemoryStore();
    const { t } = mk(live, "local");
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await t.recordFailure("1.1.1.1", "a@x.com");
    t.store = broken; // Redis cai
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(429);
  });
  it("Redis fora do ar (modo closed): login indisponível (503), sem liberar nem bloquear às cegas", async () => {
    const { t } = mk(broken, "closed");
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(503);
    await expect(t.recordFailure("1.1.1.1", "a@x.com")).resolves.toBeUndefined();
    await expect(t.recordSuccess("1.1.1.1", "a@x.com")).resolves.toBeUndefined();
  });
  it("com o Redis saudável o contador compartilhado é o que vale (modo closed não interfere)", async () => {
    const { t } = mk(new MemoryStore(), "closed");
    expect(await status(t.assertAllowed("1.1.1.1", "a@x.com"))).toBe(200);
  });
  it("contador local expira, é limitado em tamanho e não cresce sem fim", async () => {
    let now = 1_000_000;
    const l = new LocalCounterStore(100, () => now);
    await l.incr("k", 60);
    expect((await l.peek("k")).count).toBe(1);
    now += 61_000;
    expect((await l.peek("k")).count).toBe(0);
    for (let i = 0; i < 1000; i++) await l.incr(`chave-${i}`, 600);
    expect(l.size).toBeLessThanOrEqual(100);
  });
  it("chaves no Redis não contêm o e-mail em texto", async () => {
    const { t, store } = mk();
    await t.recordFailure("1.1.1.1", "pessoa@empresa.com");
    expect([...(store as MemoryStore).m.keys()].join(" ")).not.toContain("pessoa");
  });
});

describe("LoginThrottle: chaves no Redis sem dado pessoal", () => {
  it("nenhuma chave contém o e-mail nem o IP em texto, e o formato é versionado", async () => {
    const { t, store } = mk();
    await t.recordFailure("203.0.113.77", "Pessoa.Secreta@exemplo.com");
    const keys = [...(store as MemoryStore).m.keys()];
    expect(keys).toHaveLength(2);
    for (const k of keys) { expect(k).not.toMatch(/pessoa|secreta|exemplo|203\.0\.113/i); expect(k).toMatch(/^rl:login:(email|ip):v1:[0-9a-f]{32}$/); }
  });

  it("não usa SHA-256 simples do e-mail (a chave do e-mail não é reproduzível sem o segredo)", async () => {
    const { createHash } = await import("node:crypto");
    const { t, store } = mk();
    await t.recordFailure("1.1.1.1", "a@x.com");
    const simples = createHash("sha256").update("a@x.com").digest("hex").slice(0, 32);
    expect([...(store as MemoryStore).m.keys()].join(" ")).not.toContain(simples);
  });

  it("com RATE_LIMIT_HMAC_KEY definida o limite continua valendo; e é o mesmo contador para o mesmo e-mail", async () => {
    const antes = process.env.RATE_LIMIT_HMAC_KEY;
    process.env.RATE_LIMIT_HMAC_KEY = "k".repeat(32);
    try {
      const { t } = mk();
      for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await t.recordFailure(`7.7.7.${i}`, "a@x.com");
      expect(await status(t.assertAllowed("8.8.8.8", " A@X.com "))).toBe(429);
    } finally { if (antes === undefined) delete process.env.RATE_LIMIT_HMAC_KEY; else process.env.RATE_LIMIT_HMAC_KEY = antes; }
  });

  it("em produção sem RATE_LIMIT_HMAC_KEY o limitador NÃO é contornado: lança erro em vez de deixar passar", async () => {
    const [nodeEnv, key] = [process.env.NODE_ENV, process.env.RATE_LIMIT_HMAC_KEY];
    process.env.NODE_ENV = "production"; delete process.env.RATE_LIMIT_HMAC_KEY;
    try {
      const { t } = mk();
      await expect(t.assertAllowed("1.1.1.1", "a@x.com")).rejects.toThrow(/RATE_LIMIT_HMAC_KEY/);
      await expect(t.recordFailure("1.1.1.1", "a@x.com")).rejects.toThrow(/RATE_LIMIT_HMAC_KEY/);
    } finally { if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv; if (key !== undefined) process.env.RATE_LIMIT_HMAC_KEY = key; }
  });
});
