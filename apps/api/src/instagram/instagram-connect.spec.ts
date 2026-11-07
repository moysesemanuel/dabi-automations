import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptToken } from "@dabi/config";
import { ConnectError, connectInstagramAccount } from "./instagram-connect";

const KEY = randomBytes(32).toString("base64");
const TOKEN = "IGAA-token-secreto-123";

function setup(opts: { identity?: any; status?: number; existingOrg?: string; errorBody?: any } = {}) {
  const db: any = { accounts: [] as any[], creds: [] as any[], audits: [] as any[] };
  if (opts.existingOrg) db.accounts.push({ id: "acc0", organizationId: opts.existingOrg, providerAccountId: "17841", username: "dabitech.br" });
  const tx = {
    socialAccount: {
      findUnique: async () => db.accounts[0] ?? null,
      upsert: async ({ create, update }: any) => {
        if (db.accounts[0]) return Object.assign(db.accounts[0], update);
        const a = { id: "acc1", ...create }; db.accounts.push(a); return a;
      },
    },
    socialCredential: { upsert: async ({ create, update }: any) => { db.creds[0] = db.creds[0] ? { ...db.creds[0], ...update } : create; } },
    auditLog: { create: async ({ data }: any) => { db.audits.push(data); } },
  };
  const prisma: any = {
    organization: { findUnique: async ({ where }: any) => (where.id === "org1" ? { id: "org1" } : null) },
    $transaction: (fn: any) => fn(tx),
  };
  const fetchImpl: any = async () => ({
    ok: (opts.status ?? 200) < 400, status: opts.status ?? 200,
    json: async () => opts.errorBody ?? opts.identity ?? { user_id: "17841", username: "dabitech.br" },
  });
  const run = (over: any = {}) =>
    connectInstagramAccount({ prisma, tokenEncryptionKey: KEY, graphVersion: "v23.0", fetchImpl }, {
      organizationId: "org1", providerAccountId: "17841", username: "@DabiTech.br", accessToken: TOKEN, ...over,
    });
  return { run, db, prisma };
}

describe("connectInstagramAccount (modo FACEBOOK)", () => {
  it("consulta graph.facebook.com, grava loginMode e usa as permissões concedidas", async () => {
    const urls: string[] = [];
    const { db, prisma } = setup();
    const fetchImpl: any = async (u: string) => {
      urls.push(u);
      const body = u.includes("/me/permissions")
        ? { data: [{ permission: "instagram_basic", status: "granted" }, { permission: "x", status: "declined" }] }
        : { id: "17841", username: "dabitech.br" };
      return { ok: true, status: 200, json: async () => body };
    };
    await connectInstagramAccount(
      { prisma, tokenEncryptionKey: KEY, graphVersion: "v23.0", fetchImpl },
      { organizationId: "org1", providerAccountId: "17841", username: "dabitech.br", accessToken: TOKEN, loginMode: "FACEBOOK" },
    );
    expect(urls[0]).toContain("https://graph.facebook.com/v23.0/17841?");
    expect(urls.some((u) => u.includes("graph.instagram.com"))).toBe(false);
    expect(db.creds[0].loginMode).toBe("FACEBOOK");
    expect(db.creds[0].scopes).toEqual(["instagram_basic"]);
  });
});

describe("connectInstagramAccount", () => {
  it("conecta, criptografa o token e audita sem vazar o token", async () => {
    const { run, db } = setup();
    const r = await run();
    expect(r.reconnected).toBe(false);
    expect(db.creds[0].encryptedToken).not.toContain(TOKEN);
    expect(decryptToken({ encrypted: db.creds[0].encryptedToken, iv: db.creds[0].tokenIv, tag: db.creds[0].tokenTag }, KEY)).toBe(TOKEN);
    expect(db.audits[0].action).toBe("social_account.connected");
    expect(JSON.stringify(db)).not.toContain(TOKEN.slice(0, 12) + "-secreto"); // só aparece cifrado
  });
  it("reconecta conta da mesma organização", async () => {
    const { run, db } = setup({ existingOrg: "org1" });
    expect((await run()).reconnected).toBe(true);
    expect(db.audits[0].action).toBe("social_account.reconnected");
  });
  it("recusa conta já ligada a outra organização", async () => {
    const { run } = setup({ existingOrg: "orgX" });
    await expect(run()).rejects.toThrow("outra organização");
  });
  it("recusa token de outra conta ou outro username", async () => {
    await expect(setup({ identity: { user_id: "999", username: "dabitech.br" } }).run()).rejects.toThrow("id não confere");
    await expect(setup({ identity: { user_id: "17841", username: "outro" } }).run()).rejects.toThrow("outro username");
  });
  it("recusa token rejeitado pela Meta sem expor o token", async () => {
    const e: any = await setup({ status: 400, errorBody: { error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } } }).run().catch((x) => x);
    expect(e).toBeInstanceOf(ConnectError);
    expect(e.message).toContain("código 190");
    expect(e.message).not.toContain(TOKEN);
  });
  it("recusa organização inexistente", async () => {
    await expect(setup().run({ organizationId: "nao-existe" })).rejects.toThrow("Organização não encontrada");
  });
});
