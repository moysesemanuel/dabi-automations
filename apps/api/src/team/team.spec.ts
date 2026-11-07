import { beforeAll, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { createInvitationSchema, acceptInvitationNewUserSchema } from "@dabi/contracts";
import { InvitationsService } from "./invitations.service";
import { TeamService, hashToken } from "./team.service";

beforeAll(() => {
  Object.assign(process.env, { DATABASE_URL: "x", REDIS_URL: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "12345678", TOKEN_ENCRYPTION_KEY: "x", JWT_SECRET: "a".repeat(32) });
});

const dayMs = 86_400_000;

function setup() {
  const users: any[] = [
    { id: "uo", email: "dono@a.com", name: "Dono" }, { id: "ua", email: "admin@a.com", name: "Admin" },
    { id: "um", email: "membro@a.com", name: "Membro" }, { id: "ux", email: "fora@b.com", name: "Outra org" },
  ];
  const memberships: any[] = [
    { id: "m1", userId: "uo", organizationId: "A", role: "OWNER" }, { id: "m2", userId: "ua", organizationId: "A", role: "ADMIN" },
    { id: "m3", userId: "um", organizationId: "A", role: "MEMBER" }, { id: "m4", userId: "ux", organizationId: "B", role: "OWNER" },
  ];
  const invitations: any[] = [];
  const audits: any[] = [];
  const matchInv = (i: any, w: any) => Object.entries(w).every(([k, v]: any) => {
    if (k === "expiresAt" && v?.gt) return i.expiresAt > v.gt;
    return i[k] === v;
  });
  const prisma: any = {
    user: {
      findUnique: async ({ where }: any) => users.find((u) => (where.id ? u.id === where.id : u.email === where.email)) ?? null,
      create: async ({ data }: any) => { const u = { id: `u${users.length + 1}`, ...data }; users.push(u); return u; },
    },
    membership: {
      findMany: async ({ where }: any) => memberships.filter((m) => m.organizationId === where.organizationId).map((m) => ({ ...m, user: users.find((u) => u.id === m.userId) })),
      findFirst: async ({ where }: any) => memberships.find((m) => m.organizationId === where.organizationId && users.find((u) => u.id === m.userId)?.email === where.user.email) ?? null,
      findUnique: async ({ where }: any) => memberships.find((m) => m.userId === where.userId_organizationId.userId && m.organizationId === where.userId_organizationId.organizationId) ?? null,
      count: async ({ where }: any) => memberships.filter((m) => m.organizationId === where.organizationId && m.role === where.role).length,
      delete: async ({ where }: any) => { const i = memberships.findIndex((m) => m.userId === where.userId_organizationId.userId && m.organizationId === where.userId_organizationId.organizationId); return memberships.splice(i, 1)[0]; },
      update: async ({ where, data }: any) => Object.assign(memberships.find((m) => m.userId === where.userId_organizationId.userId && m.organizationId === where.userId_organizationId.organizationId)!, data),
      create: async ({ data }: any) => { const m = { id: `m${memberships.length + 1}`, ...data }; memberships.push(m); return m; },
      upsert: async ({ where, create }: any) => memberships.find((m) => m.userId === where.userId_organizationId.userId && m.organizationId === where.userId_organizationId.organizationId) ?? (memberships.push({ id: `m${memberships.length + 1}`, ...create }), create),
    },
    invitation: {
      create: async ({ data }: any) => { const i = { id: `i${invitations.length + 1}`, acceptedAt: null, revokedAt: null, createdAt: new Date(), ...data }; invitations.push(i); return i; },
      findMany: async ({ where }: any) => invitations.filter((i) => i.organizationId === where.organizationId && !i.acceptedAt && !i.revokedAt),
      findUnique: async ({ where }: any) => { const i = invitations.find((x) => x.tokenHash === where.tokenHash); return i ? { ...i, organization: { name: i.organizationId === "A" ? "Org A" : "Org B" } } : null; },
      updateMany: async ({ where, data }: any) => { const l = invitations.filter((i) => matchInv(i, where)); l.forEach((i) => Object.assign(i, data)); return { count: l.length }; },
    },
  };
  const audit: any = { log: async (a: any) => audits.push(a) };
  const team = new TeamService(prisma, audit);
  const inv = new InvitationsService(prisma, audit, { issueToken: async (id: string) => `jwt-${id}` } as any);
  return { team, inv, users, memberships, invitations, audits };
}
const owner = { userId: "uo", role: "OWNER" as const };
const admin = { userId: "ua", role: "ADMIN" as const };
const member = { userId: "um", role: "MEMBER" as const };

describe("convites", () => {
  it("cria convite: devolve o token UMA vez e guarda só o hash", async () => {
    const { team, invitations } = setup();
    const r = await team.invite("A", admin, { email: "Novo@X.com", role: "MEMBER" });
    expect(r.token.length).toBeGreaterThan(30);
    expect(invitations[0].tokenHash).toBe(hashToken(r.token));
    expect(JSON.stringify(invitations)).not.toContain(r.token);
    expect(invitations[0].email).toBe("novo@x.com");
    expect(invitations[0].expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * dayMs);
  });
  it("recusa convidar quem já é membro; novo convite revoga o anterior do mesmo e-mail", async () => {
    const { team, invitations } = setup();
    await expect(team.invite("A", owner, { email: "membro@a.com", role: "MEMBER" })).rejects.toBeInstanceOf(ConflictException);
    const a = await team.invite("A", owner, { email: "n@x.com", role: "MEMBER" });
    const b = await team.invite("A", owner, { email: "n@x.com", role: "ADMIN" });
    expect(invitations.find((i) => i.tokenHash === hashToken(a.token)).revokedAt).toBeTruthy();
    expect(invitations.find((i) => i.tokenHash === hashToken(b.token)).revokedAt).toBeNull();
  });
  it("contrato: papel OWNER não pode ser convidado; e-mail inválido é recusado", () => {
    expect(createInvitationSchema.safeParse({ email: "a@x.com", role: "OWNER" }).success).toBe(false);
    expect(createInvitationSchema.safeParse({ email: "não-é-email" }).success).toBe(false);
    expect(createInvitationSchema.parse({ email: " A@X.com " })).toEqual({ email: "a@x.com", role: "MEMBER" });
  });
  it("revogar convite de OUTRA organização dá 404", async () => {
    const { team } = setup();
    const r = await team.invite("A", owner, { email: "n@x.com", role: "MEMBER" });
    await expect(team.revoke("B", { userId: "ux", role: "OWNER" }, r.id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("lista só convites pendentes da própria organização", async () => {
    const { team } = setup();
    await team.invite("A", owner, { email: "a1@x.com", role: "MEMBER" });
    await team.invite("B", { userId: "ux", role: "OWNER" }, { email: "b1@x.com", role: "MEMBER" });
    expect((await team.invitations("A")).map((i) => i.email)).toEqual(["a1@x.com"]);
  });
});

describe("aceite de convite", () => {
  it("pessoa nova: cria conta com o e-mail do convite, vira membro com o papel convidado e o convite fica usado", async () => {
    const { team, inv, memberships, users } = setup();
    const { token } = await team.invite("A", owner, { email: "novo@x.com", role: "ADMIN" });
    const prev = await inv.preview(token);
    expect(prev).toEqual({ organizationName: "Org A", email: "novo@x.com", role: "ADMIN", accountExists: false });
    const r = await inv.acceptNew(token, { password: "senha-bem-longa-1", name: "Novo" });
    expect(r).toMatchObject({ organizationId: "A", token: expect.stringContaining("jwt-") });
    expect(memberships.some((m) => m.organizationId === "A" && m.role === "ADMIN" && users.find((u) => u.id === m.userId)?.email === "novo@x.com")).toBe(true);
    await expect(inv.acceptNew(token, { password: "senha-bem-longa-1" })).rejects.toBeInstanceOf(NotFoundException); // uso único
    await expect(inv.preview(token)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("a senha nunca é guardada em texto", async () => {
    const { team, inv, users } = setup();
    const { token } = await team.invite("A", owner, { email: "novo@x.com", role: "MEMBER" });
    await inv.acceptNew(token, { password: "senha-bem-longa-1" });
    expect(JSON.stringify(users)).not.toContain("senha-bem-longa-1");
  });
  it("convite revogado, expirado ou com token errado: mesmo erro genérico", async () => {
    const { team, inv, invitations } = setup();
    const r = await team.invite("A", owner, { email: "n@x.com", role: "MEMBER" });
    await team.revoke("A", owner, r.id);
    await expect(inv.preview(r.token)).rejects.toBeInstanceOf(NotFoundException);
    const r2 = await team.invite("A", owner, { email: "n2@x.com", role: "MEMBER" });
    invitations.find((i) => i.tokenHash === hashToken(r2.token)).expiresAt = new Date(Date.now() - 1000);
    await expect(inv.acceptNew(r2.token, { password: "senha-bem-longa-1" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(inv.preview("token-inexistente-0000000000")).rejects.toBeInstanceOf(NotFoundException);
    await expect(inv.preview("curto")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("e-mail que já tem conta: aceitar como 'novo' é recusado (409) e o convite continua válido", async () => {
    const { team, inv } = setup();
    const { token } = await team.invite("A", owner, { email: "fora@b.com", role: "MEMBER" });
    expect((await inv.preview(token)).accountExists).toBe(true);
    await expect(inv.acceptNew(token, { password: "senha-bem-longa-1" })).rejects.toBeInstanceOf(ConflictException);
    expect((await inv.acceptExisting(token, "ux")).organizationId).toBe("A");
  });
  it("conta logada com OUTRO e-mail não aceita o convite", async () => {
    const { team, inv, memberships } = setup();
    const { token } = await team.invite("A", owner, { email: "fora@b.com", role: "MEMBER" });
    await expect(inv.acceptExisting(token, "um")).rejects.toBeInstanceOf(ForbiddenException);
    expect(memberships.some((m) => m.userId === "um" && m.organizationId === "A" && m.role !== "MEMBER")).toBe(false);
  });
  it("duas aceitações simultâneas: só uma consome o convite", async () => {
    const { team, inv, memberships } = setup();
    const { token } = await team.invite("A", owner, { email: "fora@b.com", role: "MEMBER" });
    const r = await Promise.allSettled([inv.acceptExisting(token, "ux"), inv.acceptExisting(token, "ux")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(memberships.filter((m) => m.userId === "ux" && m.organizationId === "A")).toHaveLength(1);
  });
  it("contrato: senha curta é recusada", () => {
    expect(acceptInvitationNewUserSchema.safeParse({ password: "curta" }).success).toBe(false);
  });
});

describe("membros e papéis", () => {
  it("só o proprietário muda papéis; não altera outro proprietário", async () => {
    const { team } = setup();
    await expect(team.changeRole("A", admin, "um", "ADMIN")).rejects.toBeInstanceOf(ForbiddenException);
    expect((await team.changeRole("A", owner, "um", "ADMIN")).role).toBe("ADMIN");
    await expect(team.changeRole("A", owner, "uo", "MEMBER")).rejects.toBeInstanceOf(BadRequestException);
  });
  it("não muda papel de gente de outra organização", async () => {
    const { team } = setup();
    await expect(team.changeRole("A", owner, "ux", "ADMIN")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("ADMIN só remove membro comum; proprietário remove admin; ninguém remove de outra org", async () => {
    const { team } = setup();
    await expect(team.remove("A", admin, "uo")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(team.remove("A", member, "ua")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(team.remove("A", admin, "ux")).rejects.toBeInstanceOf(NotFoundException);
    await team.remove("A", admin, "um");
    await team.remove("A", owner, "ua");
  });
  it("o último proprietário não sai nem é removido; membro comum pode sair", async () => {
    const { team } = setup();
    await expect(team.remove("A", owner, "uo")).rejects.toBeInstanceOf(BadRequestException);
    await team.remove("A", member, "um");
  });
  it("lista de membros é da organização e sem hash de senha", async () => {
    const { team } = setup();
    const m = await team.members("A");
    expect(m.map((x) => x.email).sort()).toEqual(["admin@a.com", "dono@a.com", "membro@a.com"]);
    expect(JSON.stringify(m)).not.toContain("passwordHash");
  });
  it("ações são auditadas", async () => {
    const { team, audits } = setup();
    await team.invite("A", owner, { email: "n@x.com", role: "MEMBER" });
    await team.changeRole("A", owner, "um", "ADMIN");
    expect(audits.map((a) => a.action)).toEqual(["invitation.create", "member.role_change"]);
  });
});
