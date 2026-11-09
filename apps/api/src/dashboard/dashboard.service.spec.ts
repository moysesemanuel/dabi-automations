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
    { id: "s1", organizationId: "A", username: "dabitech.br", providerAccountId: "ig1", createdAt: new Date(), credential: { loginMode: "FACEBOOK", expiresAt: null, scopes: ["x"], updatedAt: new Date(), status: "NEEDS_RECONNECT", statusReason: "motivo", statusChangedAt: new Date(), encryptedToken: "NUNCA" }, _count: { media: 20, automations: 1 } },
    { id: "s2", organizationId: "B", username: "outra", providerAccountId: "ig2", createdAt: new Date(), credential: null, _count: { media: 0, automations: 0 } },
  ];
  const prisma: any = {
    messageDelivery: { ...model(deliveries), findMany: async (args: any) => (args?.where?.commentId?.in ? deliveries.filter((d) => d.organizationId === args.where.organizationId && args.where.commentId.in.includes(d.commentId)).map(({ commentId, status }) => ({ commentId, status })) : model(deliveries).findMany(args)) }, publicReply: { ...model([]), findMany: async () => [] },
    socialAccount: { ...model(accounts), findMany: async ({ where }: any) => accounts.filter((r) => match(r, where)), count: async ({ where }: any) => accounts.filter((r) => match(r, where)).length },
    socialCredential: { count: async ({ where }: any) => accounts.filter((a) => a.credential && (a.credential as any).status === where.status && a.organizationId === where.socialAccount.organizationId).length },
    // eventos: o fake aplica organizationId, status e error.startsWith de verdade
    automationEvent: (() => {
      const rows = [
        { id: "e1", organizationId: "A", status: "RECEIVED", error: "needs_review.association_mismatch", receivedAt: new Date("2026-11-09T10:00:00Z"), payload: { value: { id: "c1", text: "SEGREDO-DO-COMENTARISTA", from: { username: "usuario_secreto" } } } },
        { id: "e2", organizationId: "A", status: "RECEIVED", error: "needs_review.payload_without_comment", receivedAt: new Date("2026-11-09T11:00:00Z"), payload: {} },
        { id: "e3", organizationId: "A", status: "RECEIVED", error: null, receivedAt: new Date("2026-11-09T12:00:00Z"), payload: {} },
        { id: "e4", organizationId: "A", status: "PROCESSED", error: "needs_review.ig_account_missing", receivedAt: new Date("2026-11-09T13:00:00Z"), payload: {} },
        { id: "e5", organizationId: "A", status: "IGNORED", error: "conta desconhecida", receivedAt: new Date("2026-11-09T14:00:00Z"), payload: {} },
        { id: "e6", organizationId: "B", status: "RECEIVED", error: "needs_review.association_mismatch", receivedAt: new Date("2026-11-09T15:00:00Z"), payload: {} },
      ];
      const ok = (r: any, w: any) => r.organizationId === w.organizationId && r.status === w.status && typeof r.error === "string" && r.error.startsWith(w.error.startsWith);
      return {
        count: async ({ where }: any) => rows.filter((r) => ok(r, where)).length,
        findMany: async ({ where, take }: any) => rows.filter((r) => ok(r, where)).sort((a, b) => +b.receivedAt - +a.receivedAt).slice(0, take).map(({ id, receivedAt, status, error, payload }) => ({ id, receivedAt, status, error, payload })),
      };
    })(),
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
  it("visão geral: contas a reconectar contadas só na própria organização", async () => {
    expect((await setup().overview("A")).needsReconnect).toBe(1);
    expect((await setup().overview("B")).needsReconnect).toBe(0);
  });
  it("lista de contas expõe o estado da credencial, nunca o token", async () => {
    const [a] = await setup().accounts("A");
    expect(a.credential).toMatchObject({ connected: true, status: "NEEDS_RECONNECT", statusReason: "motivo" });
    expect(JSON.stringify(a)).not.toContain("NUNCA");
  });
  it("visão geral conta por organização e por status", async () => {
    const o = await setup().overview("A");
    expect(o).toMatchObject({ accounts: 1, needsReconnect: 1, automations: { active: 1, paused: 1 }, directMessages: { SENT: 1, FAILED: 1, PENDING: 0, HELD: 0, UNKNOWN: 0, CANCELED: 0 } });
  });
});

describe("DashboardService.attention (eventos que requerem análise)", () => {
  it("só devolve eventos RECEIVED com razão needs_review.* DA ORGANIZAÇÃO: nada de outra organização, de eventos tratados ou sem razão", async () => {
    const a = await setup().attention("A");
    expect(a.total).toBe(2);
    expect(a.items.map((i) => i.id)).toEqual(["e2", "e1"]); // mais recente primeiro
    const b = await setup().attention("B");
    expect(b.items.map((i) => i.id)).toEqual(["e6"]);
  });

  it("apresenta rótulo e detalhe FIXOS do catálogo, com severidade de atenção e a razão estável", async () => {
    const [first] = (await setup().attention("A")).items;
    expect(first).toMatchObject({ state: "needs_review", severity: "attention", reason: "needs_review.payload_without_comment" });
    expect(first.headline).toMatch(/Requer análise/);
    expect(first.detail).toMatch(/Não foi possível garantir/); // e2 não tem ID de comentário no payload: nunca afirma que nada foi enviado
  });

  it("NÃO expõe texto do comentário, autor, payload nem IDs da Meta: só ID interno do evento", async () => {
    const r = await setup().attention("A");
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/SEGREDO|usuario_secreto/); // dados do comentarista
    expect(json).not.toContain('"payload"'); // a chave payload (o código de razão pode conter a palavra)
    expect(json).not.toMatch(/"from"|"text"|providerEventKey/);
    expect(Object.keys(r.items[0]).sort()).toEqual(["detail", "headline", "id", "reason", "receivedAt", "severity", "state"]);
  });

  it("limita o tamanho da página (1 a 50) e trata valores inválidos", async () => {
    expect((await setup().attention("A", 1)).items).toHaveLength(1);
    expect((await setup().attention("A", 1)).total).toBe(2); // total continua o real
    expect((await setup().attention("A", 0)).items.length).toBeGreaterThan(0);
    expect((await setup().attention("A", 9999)).items).toHaveLength(2);
    expect((await setup().attention("A", NaN as any)).items).toHaveLength(2);
  });

  it("a visão geral traz a contagem de eventos que requerem análise, restrita à organização", async () => {
    expect((await setup().overview("A")).needsReview).toBe(2);
    expect((await setup().overview("B")).needsReview).toBe(1);
  });
});

describe("DashboardService.attention: 'nada foi enviado' só com garantia", () => {
  it("comentário SEM entrega registrada (e2→ sem id) e com id sem entrega: afirma só quando consultou e não achou", async () => {
    const items = (await setup().attention("A")).items;
    const e1 = items.find((i) => i.id === "e1")!; // comentário c1 da org A: existe a entrega d1 (SENT) → conservador
    expect(e1.detail).toMatch(/Já existe entrega registrada/);
    expect(e1.detail).not.toMatch(/nada foi enviado por ele/i);
    const e2 = items.find((i) => i.id === "e2")!; // sem ID de comentário no payload: não há como provar
    expect(e2.detail).toMatch(/Não foi possível garantir/);
    expect(e2.detail).not.toMatch(/nada foi enviado por ele/i);
  });
});
