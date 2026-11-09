import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptToken } from "@dabi/config";
import { SubscriptionError, subscribeAccountWebhook, subscriptionAllowed } from "./webhook-subscription";

const KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAtoken-secreto-XYZ";

function setup(o: { allowed?: string; res?: { status?: number; body?: any }; netFail?: boolean; noCred?: boolean } = {}) {
  const enc = encryptToken(TOKEN, KEY);
  const accounts: any[] = [
    { id: "acc1", organizationId: "orgA", providerAccountId: "17841", webhookStatus: "UNKNOWN", webhookSubscribedAt: null, webhookError: null, credential: o.noCred ? null : { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag } },
    { id: "acc2", organizationId: "orgB", providerAccountId: "99999", webhookStatus: "UNKNOWN", webhookSubscribedAt: null, webhookError: null, credential: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag } },
  ];
  const audits: any[] = [];
  const marks: any[] = [];
  const calls: { url: string; init: any }[] = [];
  const prisma: any = {
    socialAccount: {
      findFirst: async ({ where }: any) => accounts.find((a) => a.id === where.id && a.organizationId === where.organizationId) ?? null,
      updateMany: async ({ where, data }: any) => { const a = accounts.find((x) => x.id === where.id && x.organizationId === where.organizationId); if (a) Object.assign(a, data); return { count: a ? 1 : 0 }; },
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); } },
    socialCredential: { updateMany: async (a: any) => { marks.push(a); return { count: 1 }; } },
  };
  const fetchImpl: any = async (url: string, init: any) => {
    calls.push({ url, init });
    if (o.netFail) throw new Error("net");
    return { ok: (o.res?.status ?? 200) < 400, status: o.res?.status ?? 200, json: async () => o.res?.body ?? { success: true } };
  };
  const deps = { prisma, env: { tokenEncryptionKey: KEY, graphVersion: "v23.0", allowedAccounts: o.allowed ?? "17841" }, fetchImpl, now: () => new Date("2026-11-08T12:00:00Z") };
  return { deps, accounts, audits, calls, marks };
}
const run = (s: ReturnType<typeof setup>, over: any = {}) => subscribeAccountWebhook(s.deps, { organizationId: "orgA", accountId: "acc1", actorUserId: "u1", ...over });

describe("subscriptionAllowed", () => {
  it("vazio = desligado; * = todas; lista = só os IDs citados", () => {
    expect(subscriptionAllowed("", "1")).toBe(false);
    expect(subscriptionAllowed("*", "1")).toBe(true);
    expect(subscriptionAllowed("1, 2", "2")).toBe(true);
    expect(subscriptionAllowed("1,2", "3")).toBe(false);
  });
});

describe("subscribeAccountWebhook", () => {
  it("sucesso: POST /{ig-id}/subscribed_apps com subscribed_fields=comments, token só no cabeçalho", async () => {
    const s = setup();
    const r = await run(s);
    expect(r).toMatchObject({ status: "SUBSCRIBED", error: null });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].url).toBe("https://graph.facebook.com/v23.0/17841/subscribed_apps");
    expect(s.calls[0].init.method).toBe("POST");
    expect(String(s.calls[0].init.body)).toBe("subscribed_fields=comments");
    expect(s.calls[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(s.calls[0].url).not.toContain(TOKEN);
    expect(s.accounts[0]).toMatchObject({ webhookStatus: "SUBSCRIBED", webhookError: null });
    expect(s.audits[0]).toMatchObject({ action: "social_account.webhook_subscribed", organizationId: "orgA", userId: "u1" });
    expect(JSON.stringify(s.audits)).not.toContain(TOKEN);
  });

  it("idempotente: repetir mantém ATIVA e não cria estado inconsistente", async () => {
    const s = setup();
    await run(s); const r2 = await run(s);
    expect(r2.status).toBe("SUBSCRIBED");
    expect(s.accounts[0].webhookStatus).toBe("SUBSCRIBED");
    expect(s.accounts[1].webhookStatus).toBe("UNKNOWN"); // outras contas intactas
  });

  it("isolamento: conta de outra organização => not_found e nenhuma chamada à Meta", async () => {
    const s = setup({ allowed: "*" });
    await expect(run(s, { accountId: "acc2" })).rejects.toMatchObject({ code: "not_found" });
    expect(s.calls).toHaveLength(0);
    expect(s.accounts[1].webhookStatus).toBe("UNKNOWN");
  });

  it("desligado por padrão e restrito à lista: outras contas são recusadas sem chamar a Meta", async () => {
    for (const allowed of ["", "55555"]) {
      const s = setup({ allowed });
      await expect(run(s)).rejects.toMatchObject({ code: "disabled" });
      expect(s.calls).toHaveLength(0);
    }
  });

  it("sem credencial: recusa", async () => {
    await expect(run(setup({ noCred: true }))).rejects.toBeInstanceOf(SubscriptionError);
  });

  it("erro da Meta: registra FALHOU com mensagem segura (sem token) e auditoria", async () => {
    const s = setup({ res: { status: 400, body: { error: { code: 100, message: `Permissão negada para ${TOKEN}` } } } });
    const r = await run(s);
    expect(r.status).toBe("FAILED");
    expect(r.error).toContain("código 100");
    expect(JSON.stringify([r, s.accounts[0], s.audits])).not.toContain(TOKEN);
    expect(s.accounts[0].webhookStatus).toBe("FAILED");
    expect(s.audits[0].action).toBe("social_account.webhook_failed");
  });

  it("erro 190 na assinatura: marca a credencial para reconexão e orienta o usuário", async () => {
    const s = setup({ res: { status: 400, body: { error: { code: 190, message: "Error validating access token" } } } });
    const r = await run(s);
    expect(r).toMatchObject({ status: "FAILED" });
    expect(r.error).toMatch(/Reconecte/);
    expect(s.marks).toHaveLength(1);
    expect(s.marks[0].where.socialAccountId).toBe("acc1");
  });

  it("success diferente de true conta como falha; rede fora do ar também", async () => {
    expect((await run(setup({ res: { body: { success: false } } }))).status).toBe("FAILED");
    const s = setup({ netFail: true });
    const r = await run(s);
    expect(r).toMatchObject({ status: "FAILED" });
    expect(r.error).toMatch(/Meta/);
  });

  it("falha depois de sucesso não apaga a data da última assinatura bem-sucedida", async () => {
    const s = setup();
    await run(s);
    const when = s.accounts[0].webhookSubscribedAt;
    s.deps.fetchImpl = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    await run(s);
    expect(s.accounts[0].webhookStatus).toBe("FAILED");
    expect(s.accounts[0].webhookSubscribedAt).toEqual(when);
  });
});

describe("subscribeAccountWebhook: classificação do erro da Meta (regressão)", () => {
  const body = (code: number, error_subcode?: number) => ({ error: { code, ...(error_subcode !== undefined ? { error_subcode } : {}), message: "erro de teste" } });

  for (const sub of [undefined, 458, 460, 463, 467]) {
    it(`190${sub ? "/" + sub : " sem subcódigo"}: marca a credencial para reconexão (igual a antes)`, async () => {
      const s = setup({ res: { status: 400, body: body(190, sub) } });
      const r = await run(s);
      expect(r.status).toBe("FAILED");
      expect(s.marks).toHaveLength(1);
      expect(r.error).toMatch(/Reconecte/);
    });
  }

  for (const sub of [459, 464]) {
    it(`190/${sub} (ação do usuário no Facebook): NÃO marca a credencial; registra o erro com o código`, async () => {
      const s = setup({ res: { status: 400, body: body(190, sub) } });
      const r = await run(s);
      expect(r.status).toBe("FAILED");
      expect(s.marks).toHaveLength(0);
      expect(r.error).toContain("código 190");
    });
  }

  it("200 sem subcódigo e demais da faixa 200–299: NÃO marca a credencial e a mensagem é segura (sem token)", async () => {
    for (const code of [200, 210, 299, 10]) {
      const s = setup({ res: { status: 400, body: body(code) } });
      const r = await run(s);
      expect(r.status).toBe("FAILED");
      expect(s.marks).toHaveLength(0);
      expect(r.error).toContain(`código ${code}`);
      expect(r.error).not.toContain(TOKEN);
    }
  });
});
