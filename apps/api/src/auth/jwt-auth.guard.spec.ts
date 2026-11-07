import { describe, expect, it, beforeAll } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { JwtAuthGuard } from "./jwt-auth.guard";

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "x", REDIS_URL: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "12345678",
    TOKEN_ENCRYPTION_KEY: "x", JWT_SECRET: "a".repeat(32),
  });
});

async function run(userExists: boolean, token?: string) {
  const jwt = new JwtService();
  const prisma: any = { user: { findUnique: async ({ where }: any) => (userExists ? { id: where.id } : null) } };
  const guard = new JwtAuthGuard(jwt, prisma);
  const valid = await jwt.signAsync({ sub: "u1" }, { secret: "a".repeat(32), expiresIn: "1h" });
  const req: any = { headers: { authorization: `Bearer ${token ?? valid}` } };
  const ok = await guard.canActivate({ switchToHttp: () => ({ getRequest: () => req }) } as any);
  return { ok, req };
}

describe("JwtAuthGuard", () => {
  it("aceita token válido de usuário existente", async () => {
    const { ok, req } = await run(true);
    expect(ok).toBe(true);
    expect(req.user).toEqual({ id: "u1" });
  });
  it("recusa token válido de usuário que não existe mais", async () => {
    await expect(run(false)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it("recusa token adulterado", async () => {
    await expect(run(true, "abc.def.ghi")).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
