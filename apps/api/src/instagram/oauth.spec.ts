import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { decryptToken } from "@dabi/config";
import { META_UNIFIED_LOGIN, MemoryOAuthStateStore, metaUnifiedLogin, OAuthError, REQUIRED_PERMISSIONS, completeInstagramOAuth, startInstagramOAuth, type OAuthDeps } from "./oauth";

const KEY = randomBytes(32).toString("base64");
const SECRET = "app-secret-XYZ";
const CODE = "code-abc-123";
const TOKEN = "EAAtoken-secreto-999";
const env = { appId: "111", appSecret: SECRET, configId: "1819418769102692", redirectUri: "https://dev.example.com/instagram/callback", graphVersion: "v23.0", tokenEncryptionKey: KEY };

interface Opts {
  members?: Record<string, "OWNER" | "ADMIN" | "MEMBER">; // "userId:orgId" -> papel
  accounts?: { id: string; username: string }[];
  perms?: string[] | "fail";
  exchange?: { status?: number; body?: any };
  existing?: { providerAccountId: string; organizationId: string }[];
}

function setup(o: Opts = {}) {
  const now = { t: 1_000_000 };
  const store = new MemoryOAuthStateStore(() => now.t);
  const db = { accounts: [...(o.existing ?? [])].map((a, i) => ({ id: `old${i}`, username: "x", ...a })) as any[], creds: [] as any[], audits: [] as any[] };
  const members = o.members ?? { "u1:org1": "OWNER" };
  const tx = {
    socialAccount: {
      findUnique: async ({ where }: any) => db.accounts.find((a) => a.providerAccountId === where.provider_providerAccountId.providerAccountId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const e = db.accounts.find((a) => a.providerAccountId === where.provider_providerAccountId.providerAccountId);
        if (e) return Object.assign(e, update);
        const a = { id: `acc${db.accounts.length}`, ...create }; db.accounts.push(a); return a;
      },
    },
    socialCredential: { upsert: async ({ create }: any) => { db.creds.push(create); } },
    auditLog: { create: async ({ data }: any) => { db.audits.push(data); } },
  };
  const prisma: any = {
    membership: { findUnique: async ({ where }: any) => { const k = `${where.userId_organizationId.userId}:${where.userId_organizationId.organizationId}`; return members[k] ? { role: members[k] } : null; } },
    organization: { findUnique: async ({ where }: any) => ({ id: where.id }) },
    socialAccount: tx.socialAccount,
    $transaction: (fn: any) => fn(tx),
  };
  const calls: string[] = [];
  const fetchImpl: any = async (url: string) => {
    calls.push(url);
    const ok = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.includes("/oauth/access_token")) return ok(o.exchange?.body ?? { access_token: TOKEN, token_type: "bearer" }, o.exchange?.status ?? 200);
    if (url.includes("/me/permissions")) return o.perms === "fail" ? ok({ error: { message: "x" } }, 400) : ok({ data: (o.perms ?? [...REQUIRED_PERMISSIONS]).map((p) => ({ permission: p, status: "granted" })) });
    if (url.includes("/me/assigned_instagram_accounts")) return ok({ data: o.accounts ?? [{ id: "17841", username: "cliente.novo" }] });
    const m = url.match(/graph\.facebook\.com\/v23\.0\/(\d+)\?fields=id,username/);
    if (m) return ok({ id: m[1], username: (o.accounts ?? [{ id: "17841", username: "cliente.novo" }]).find((a) => a.id === m[1])?.username });
    return ok({}, 404);
  };
  const deps: OAuthDeps = { prisma, store, env, fetchImpl };
  const begin = async (userId = "u1", orgId = "org1") => {
    const { url } = await startInstagramOAuth(deps, { userId, organizationId: orgId });
    return new URL(url).searchParams.get("state")!;
  };
  return { deps, db, store, calls, now, begin };
}

describe("startInstagramOAuth", () => {
  it("monta a URL do Unified Login com config_id, redirect_uri e state aleatório; só o hash vai ao store", async () => {
    const s = setup();
    const { url } = await startInstagramOAuth(s.deps, { userId: "u1", organizationId: "org1" });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://www.facebook.com/dialog/oauth");
    expect(u.searchParams.get("client_id")).toBe("111");
    expect(u.searchParams.get("config_id")).toBe("1819418769102692");
    expect(u.searchParams.get("redirect_uri")).toBe(env.redirectUri);
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("override_default_response_type")).toBe("true");
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(url).not.toContain(SECRET);
    const a = await s.begin(), b = await s.begin();
    expect(a).not.toBe(b);
  });
  it("exige papel OWNER/ADMIN, config completa e redirect HTTPS", async () => {
    await expect(startInstagramOAuth(setup({ members: { "u1:org1": "MEMBER" } }).deps, { userId: "u1", organizationId: "org1" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(startInstagramOAuth(setup().deps, { userId: "u1", organizationId: "outra" })).rejects.toMatchObject({ code: "forbidden" });
    const s = setup();
    await expect(startInstagramOAuth({ ...s.deps, env: { ...env, configId: "" } }, { userId: "u1", organizationId: "org1" })).rejects.toMatchObject({ code: "not_configured" });
    await expect(startInstagramOAuth({ ...s.deps, env: { ...env, redirectUri: "http://localhost:3000/instagram/callback" } }, { userId: "u1", organizationId: "org1" })).rejects.toMatchObject({ code: "not_configured" });
  });
  it("se o store (Redis) falhar, não inicia o fluxo", async () => {
    const s = setup();
    s.deps.store = { put: async () => { throw new Error("redis"); }, take: async () => null };
    await expect(startInstagramOAuth(s.deps, { userId: "u1", organizationId: "org1" })).rejects.toBeInstanceOf(OAuthError);
  });
});

describe("ConnectionProvider", () => {
  it("o provedor atual é o Unified Login e grava seu id no state", async () => {
    const s = setup();
    expect(metaUnifiedLogin.id).toBe(META_UNIFIED_LOGIN);
    const { url } = await metaUnifiedLogin.start(s.deps, { userId: "u1", organizationId: "org1" });
    const state = new URL(url).searchParams.get("state")!;
    expect((await metaUnifiedLogin.complete(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("connected");
  });
  it("state emitido por outro provedor é recusado", async () => {
    const s = setup();
    await s.deps.store.put("ig-oauth:" + (await import("node:crypto")).createHash("sha256").update("outro").digest("hex"), { userId: "u1", organizationId: "org1", provider: "outro-provedor" }, 600);
    expect((await metaUnifiedLogin.complete(s.deps, { userId: "u1", state: "outro", code: CODE })).outcome).toBe("expired");
    expect(s.calls).toHaveLength(0);
  });
});

describe("redirect_uri", () => {
  it("é idêntico, byte a byte, ao cadastrado na Meta na autorização e na troca do code", async () => {
    const REGISTRADO = "https://dev.example.com/instagram/callback";
    const s = setup();
    const state = await s.begin();
    const { url } = await startInstagramOAuth(s.deps, { userId: "u1", organizationId: "org1" });
    expect(new URL(url).searchParams.get("redirect_uri")).toBe(REGISTRADO);
    await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE });
    expect(new URL(s.calls[0]).searchParams.get("redirect_uri")).toBe(REGISTRADO);
  });
});

describe("completeInstagramOAuth", () => {
  it("sucesso: troca o code, descobre a conta, grava token criptografado (FACEBOOK) na organização do state", async () => {
    const s = setup();
    const state = await s.begin();
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE });
    expect(r).toMatchObject({ outcome: "connected", organizationId: "org1", connected: [{ username: "cliente.novo" }] });
    expect(s.db.accounts[0]).toMatchObject({ organizationId: "org1", providerAccountId: "17841" });
    const c = s.db.creds[0];
    expect(c.loginMode).toBe("FACEBOOK");
    expect(JSON.stringify(c)).not.toContain(TOKEN);
    expect(decryptToken({ encrypted: c.encryptedToken, iv: c.tokenIv, tag: c.tokenTag }, KEY)).toBe(TOKEN);
    expect(s.db.audits[0]).toMatchObject({ action: "social_account.connected", userId: "u1", organizationId: "org1" });
    expect(JSON.stringify(s.db.audits)).not.toContain(TOKEN);
    const ex = new URL(s.calls[0]);
    expect(ex.pathname).toBe("/v23.0/oauth/access_token");
    expect(ex.searchParams.get("redirect_uri")).toBe(env.redirectUri);
  });

  it("cancelamento (access_denied): não troca code, não conecta, consome o state", async () => {
    const s = setup();
    const state = await s.begin();
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state, error: "access_denied", errorReason: "user_denied" });
    expect(r).toMatchObject({ outcome: "cancelled", organizationId: "org1" });
    expect(s.calls).toHaveLength(0);
    expect(s.db.accounts).toHaveLength(0);
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("expired");
  });

  it("token/code inválido: erro, nada gravado e nenhum segredo vaza", async () => {
    const s = setup({ exchange: { status: 400, body: { error: { message: `Invalid code ${CODE} for secret ${SECRET}`, code: 100 } } } });
    const state = await s.begin();
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE });
    expect(r).toMatchObject({ outcome: "error", organizationId: "org1" });
    expect(s.db.accounts).toHaveLength(0);
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${SECRET}|${CODE}`));
  });

  it("state expirado (>10 min) é recusado sem chamar a Meta", async () => {
    const s = setup();
    const state = await s.begin();
    s.now.t += 601_000;
    expect(await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).toMatchObject({ outcome: "expired", organizationId: undefined });
    expect(s.calls).toHaveLength(0);
  });

  it("state inventado ou já usado é recusado (replay)", async () => {
    const s = setup();
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state: "forjado", code: CODE })).outcome).toBe("expired");
    const state = await s.begin();
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("connected");
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("expired");
    expect(s.db.creds).toHaveLength(1);
  });

  it("concorrência: o mesmo state em 8 retornos simultâneos só conecta uma vez", async () => {
    const s = setup();
    const state = await s.begin();
    const rs = await Promise.all(Array.from({ length: 8 }, () => completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })));
    expect(rs.filter((r) => r.outcome === "connected")).toHaveLength(1);
    expect(rs.filter((r) => r.outcome === "expired")).toHaveLength(7);
    expect(s.calls.filter((u) => u.includes("/oauth/access_token"))).toHaveLength(1);
    expect(s.db.creds).toHaveLength(1);
  });

  it("CSRF: state criado por outro usuário não vale (e é queimado)", async () => {
    const s = setup({ members: { "u1:org1": "OWNER", "u2:org2": "OWNER" } });
    const stateAtacante = await s.begin("u2", "org2");
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state: stateAtacante, code: CODE });
    expect(r).toMatchObject({ outcome: "forbidden", organizationId: undefined });
    expect(s.calls).toHaveLength(0);
    expect(s.db.accounts).toHaveLength(0);
    expect((await completeInstagramOAuth(s.deps, { userId: "u2", state: stateAtacante, code: CODE })).outcome).toBe("expired");
  });

  it("papel revogado entre o início e o retorno: recusa", async () => {
    const members: any = { "u1:org1": "OWNER" };
    const s = setup({ members });
    const state = await s.begin();
    members["u1:org1"] = "MEMBER";
    expect(await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).toMatchObject({ outcome: "forbidden", organizationId: "org1" });
    expect(s.db.accounts).toHaveLength(0);
  });

  it("permissões insuficientes (cliente desmarcou mensagens): não conecta", async () => {
    const s = setup({ perms: ["instagram_basic", "instagram_manage_comments"] });
    const state = await s.begin();
    expect(await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).toMatchObject({ outcome: "insufficient_permissions" });
    expect(s.db.accounts).toHaveLength(0);
    expect(s.calls.some((u) => u.includes("assigned_instagram_accounts"))).toBe(false);
  });

  it("se a Meta não informar permissões, segue (a consulta de contas valida o acesso)", async () => {
    const s = setup({ perms: "fail" });
    const state = await s.begin();
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("connected");
  });

  it("conta já conectada a OUTRA organização não é tocada", async () => {
    const s = setup({ existing: [{ providerAccountId: "17841", organizationId: "orgB" }] });
    const state = await s.begin();
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE });
    expect(r).toMatchObject({ outcome: "other_organization", skipped: [{ username: "cliente.novo", reason: "other_organization" }] });
    expect(s.db.creds).toHaveLength(0);
    expect(s.db.accounts[0].organizationId).toBe("orgB");
  });

  it("conta já conectada nesta organização (ex.: @dabitech.br) mantém o token existente", async () => {
    const s = setup({ existing: [{ providerAccountId: "17841", organizationId: "org1" }] });
    const state = await s.begin();
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("already_connected");
    expect(s.db.creds).toHaveLength(0);
    expect(s.calls.filter((u) => u.includes("graph.facebook.com/v23.0/17841"))).toHaveLength(0);
  });

  it("várias contas: conecta as novas e informa as ignoradas (partial)", async () => {
    const s = setup({ accounts: [{ id: "1", username: "a" }, { id: "2", username: "b" }], existing: [{ providerAccountId: "2", organizationId: "org1" }] });
    const state = await s.begin();
    const r = await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE });
    expect(r.outcome).toBe("partial");
    expect(r.connected.map((c) => c.username)).toEqual(["a"]);
    expect(r.skipped).toEqual([{ username: "b", reason: "already_connected" }]);
  });

  it("nenhuma conta atribuída: no_accounts", async () => {
    const s = setup({ accounts: [] });
    const state = await s.begin();
    expect((await completeInstagramOAuth(s.deps, { userId: "u1", state, code: CODE })).outcome).toBe("no_accounts");
  });

  it("falha do store ao consumir o state: 503 (OAuthError), nada é conectado", async () => {
    const s = setup();
    s.deps.store = { put: async () => {}, take: async () => { throw new Error("redis"); } };
    await expect(completeInstagramOAuth(s.deps, { userId: "u1", state: "x", code: CODE })).rejects.toMatchObject({ code: "store_unavailable" });
  });
});
