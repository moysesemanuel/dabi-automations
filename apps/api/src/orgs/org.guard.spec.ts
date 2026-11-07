import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OrgGuard } from "./org.guard";

const memberships = [{ userId: "u1", organizationId: "orgA", role: "ADMIN" }];
const prisma: any = {
  membership: {
    findUnique: async ({ where }: any) => {
      const k = where.userId_organizationId;
      return memberships.find((m) => m.userId === k.userId && m.organizationId === k.organizationId) ?? null;
    },
  },
};
const ctx = (user: any, orgId: any, roles?: string[]): any => ({
  switchToHttp: () => ({ getRequest: () => ({ user, params: { orgId } }) }),
  getHandler: () => "h",
});
const guard = (roles?: string[]) => {
  const reflector = { get: () => roles } as unknown as Reflector;
  return new OrgGuard(prisma, reflector);
};

describe("OrgGuard (isolamento entre organizações)", () => {
  it("permite membro da própria organização", async () => {
    expect(await guard().canActivate(ctx({ id: "u1" }, "orgA"))).toBe(true);
  });
  it("bloqueia usuário de outra organização", async () => {
    await expect(guard().canActivate(ctx({ id: "u1" }, "orgB"))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("bloqueia sem usuário autenticado", async () => {
    await expect(guard().canActivate(ctx(undefined, "orgA"))).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("respeita papel exigido", async () => {
    await expect(guard(["OWNER"]).canActivate(ctx({ id: "u1" }, "orgA"))).rejects.toBeInstanceOf(ForbiddenException);
    expect(await guard(["OWNER", "ADMIN"]).canActivate(ctx({ id: "u1" }, "orgA"))).toBe(true);
  });
});
