import { describe, expect, it, beforeAll } from "vitest";
import { HttpException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { LoginThrottle, MAX_FAILURES_PER_EMAIL, type CounterStore } from "./login-throttle";

beforeAll(() => {
  Object.assign(process.env, { DATABASE_URL: "x", REDIS_URL: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "12345678", TOKEN_ENCRYPTION_KEY: "x", JWT_SECRET: "a".repeat(32) });
});

function setup() {
  const m = new Map<string, number>();
  const store: CounterStore = {
    incr: async (k) => { m.set(k, (m.get(k) ?? 0) + 1); return m.get(k)!; },
    peek: async (k) => ({ count: m.get(k) ?? 0, ttl: 60 }),
    del: async (k) => { m.delete(k); },
  };
  const throttle = new LoginThrottle(); throttle.store = store;
  const hash = bcrypt.hashSync("senha-correta-123", 4);
  const prisma: any = { user: { findUnique: async ({ where }: any) => (where.email === "ok@x.com" ? { id: "u1", email: "ok@x.com", passwordHash: hash } : null) } };
  const audits: any[] = [];
  const svc = new AuthService(prisma, new JwtService(), { log: async (a: any) => audits.push(a) } as any, throttle);
  return { svc, audits };
}

describe("AuthService.login + limite de tentativas", () => {
  it("login correto devolve token", async () => {
    const { svc } = setup();
    expect((await svc.login({ email: "ok@x.com", password: "senha-correta-123" }, "1.1.1.1")).token).toBeTruthy();
  });
  it("senha errada: 401; depois do limite, 429 mesmo com a senha correta", async () => {
    const { svc } = setup();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await expect(svc.login({ email: "ok@x.com", password: "errada" }, "1.1.1.1")).rejects.toBeInstanceOf(UnauthorizedException);
    const e = await svc.login({ email: "ok@x.com", password: "senha-correta-123" }, "1.1.1.1").catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(429);
  });
  it("e-mail inexistente também conta e bloqueia (não revela se existe)", async () => {
    const { svc } = setup();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await svc.login({ email: "nao@x.com", password: "x" }, "2.2.2.2").catch(() => {});
    expect((await svc.login({ email: "nao@x.com", password: "x" }, "2.2.2.2").catch((x) => x)).getStatus()).toBe(429);
  });
  it("o bloqueio acontece antes do bcrypt (sem gastar CPU)", async () => {
    const { svc, audits } = setup();
    for (let i = 0; i < MAX_FAILURES_PER_EMAIL; i++) await svc.login({ email: "ok@x.com", password: "errada" }, "1.1.1.1").catch(() => {});
    const before = audits.length;
    await svc.login({ email: "ok@x.com", password: "errada" }, "1.1.1.1").catch(() => {});
    expect(audits.length).toBe(before); // nada foi auditado/processado: parou no limitador
  });
});
