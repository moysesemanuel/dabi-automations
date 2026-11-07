import { describe, expect, it } from "vitest";
import { DashboardService } from "./dashboard.service";

/** Fake que aplica o filtro `where` de verdade: prova o isolamento por organização. */
function setup() {
  const match = (o: any, w: any) => Object.entries(w).every(([k, v]) => o[k] === v);
  const deliveries = [
    { id: "d1", organizationId: "A", automationId: "a1", commentId: "c1", status: "SENT", attempts: 1, error: null, providerResponse: { message_id: "m1", recipient_id: "SECRET_IGSID" }, createdAt: new Date(3), updatedAt: new Date(3), automation: { id: "a1", keyword: "LINK", media: { permalink: "https://ig/p/1" } } },
    { id: "d2", organizationId: "A", automationId: "a1", commentId: "c2", status: "FAILED", attempts: 1, error: "x", providerResponse: { http: 400, code: 10, error_subcode: 5, fbtrace_id: "t" }, createdAt: new Date(2), updatedAt: new Date(2), automation: { id: "a1", keyword: "LINK", media: null } },
    { id: "d3", organizationId: "B", automationId: "b1", commentId: "c3", status: "SENT", attempts: 1, error: null, providerResponse: null, createdAt: new Date(1), updatedAt: new Date(1), automation: { id: "b1", keyword: "OUTRA", media: null } },
  ];
  const model = (rows: any[]) => ({
    count: async ({ where }: any) => rows.filter((r) => match(r, where)).length,
    findMany: async ({ where, skip = 0, take = 999 }: any) => rows.filter((r) => match(r, where)).sort((a, b) => +b.createdAt - +a.createdAt).slice(skip, skip + take),
    groupBy: async ({ where }: any) => {
      const g: Record<string, number> = {};
      rows.filter((r) => match(r, where)).forEach((r) => (g[r.status] = (g[r.status] ?? 0) + 1));
      return Object.entries(g).map(([status, n]) => ({ status, _count: { _all: n } }));
    },
  });
  const accounts = [
    { id: "s1", organizationId: "A", username: "dabitech.br", providerAccountId: "ig1", createdAt: new Date(), credential: { loginMode: "FACEBOOK", expiresAt: null, scopes: ["x"], updatedAt: new Date(), encryptedToken: "NUNCA" }, _count: { media: 20, automations: 1 } },
    { id: "s2", organizationId: "B", username: "outra", providerAccountId: "ig2", createdAt: new Date(), credential: null, _count: { media: 0, automations: 0 } },
  ];
  const prisma: any = {
    messageDelivery: model(deliveries), publicReply: model([]),
    socialAccount: { ...model(accounts), findMany: async ({ where }: any) => accounts.filter((r) => match(r, where)), count: async ({ where }: any) => accounts.filter((r) => match(r, where)).length },
    media: model([{ organizationId: "A", status: "x" }]), automation: model([{ organizationId: "A", status: "ACTIVE" }, { organizationId: "A", status: "PAUSED" }, { organizationId: "B", status: "ACTIVE" }]),
  };
  return new DashboardService(prisma);
}

describe("DashboardService", () => {
  it("histórico só devolve linhas da organização informada", async () => {
    const r = await setup().history("A", "dm", {});
    expect(r.items.map((i: any) => i.id)).toEqual(["d1", "d2"]);
    expect(r.total).toBe(2);
    const other = await setup().history("B", "dm", {});
    expect(other.items.map((i: any) => i.id)).toEqual(["d3"]);
  });
  it("filtro por automação de outra organização não vaza nada", async () => {
    const r = await setup().history("A", "dm", { automationId: "b1" });
    expect(r.items).toHaveLength(0);
  });
  it("filtra por status válido e ignora status inválido", async () => {
    expect((await setup().history("A", "dm", { status: "FAILED" })).items.map((i: any) => i.id)).toEqual(["d2"]);
    expect((await setup().history("A", "dm", { status: "DROP TABLE" })).total).toBe(2);
  });
  it("pagina e limita o tamanho da página", async () => {
    const r = await setup().history("A", "dm", { page: 2, pageSize: 1 });
    expect(r).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(r.items.map((i: any) => i.id)).toEqual(["d2"]);
    expect((await setup().history("A", "dm", { pageSize: 9999 })).pageSize).toBe(50);
    expect((await setup().history("A", "dm", { page: -5 })).page).toBe(1);
  });
  it("não expõe recipient_id, token nem dados da credencial", async () => {
    const svc = setup();
    const h = JSON.stringify(await svc.history("A", "dm", {}));
    expect(h).not.toContain("SECRET_IGSID");
    expect(h).toContain("m1");
    const acc = JSON.stringify(await svc.accounts("A"));
    expect(acc).not.toContain("NUNCA");
    expect(acc).not.toContain("encryptedToken");
  });
  it("contas: só da organização; sem credencial aparece como não conectada", async () => {
    const a = await setup().accounts("A");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ username: "dabitech.br", mediaCount: 20, credential: { connected: true, loginMode: "FACEBOOK" } });
    expect((await setup().accounts("B"))[0].credential).toEqual({ connected: false });
  });
  it("visão geral conta por organização e por status", async () => {
    const o = await setup().overview("A");
    expect(o).toMatchObject({ accounts: 1, automations: { active: 1, paused: 1 }, directMessages: { SENT: 1, FAILED: 1, PENDING: 0, UNKNOWN: 0 } });
  });
});
