import { describe, it, expect, vi } from "vitest";
import { opsWhere, parseSince, queryOperatorEvents } from "./events-report";

const NOW = new Date("2026-11-09T12:00:00Z");
const ev = (id: string, o: Partial<any> = {}) => ({ id, receivedAt: new Date("2026-11-09T10:00:00Z"), status: "RECEIVED", error: null, organizationId: "A", socialAccountId: "s1", igAccountId: "ig", payload: { value: { text: "SEGREDO-DO-COMENTARISTA", from: { username: "usuario_secreto" } } }, ...o });
const ROWS = [
  ev("nr-A", { error: "needs_review.association_mismatch", organizationId: "A" }),
  ev("nr-B", { error: "needs_review.association_mismatch", organizationId: "B" }),
  ev("nr-sem-org", { error: "needs_review.ig_account_missing", organizationId: null, socialAccountId: null, igAccountId: null }),
  ev("drop-sem-org", { status: "IGNORED", error: "dropped.tombstone", organizationId: null, igAccountId: null }),
  ev("drop-A", { status: "IGNORED", error: "dropped.tombstone", organizationId: "A" }),
  ev("ign-sem-org", { status: "IGNORED", error: "conta desconhecida", organizationId: null, igAccountId: null }),
  ev("ok-A", { status: "PROCESSED", error: null, organizationId: "A", receivedAt: new Date("2026-11-01T10:00:00Z") }),
];
/** Fake que APLICA o where e o select de verdade (startsWith, gte, igualdade inclusive null). */
function fake() {
  const calls: any[] = [];
  const match = (r: any, w: any) => Object.entries(w).every(([k, v]: [string, any]) => v && typeof v === "object" && !(v instanceof Date) ? ("startsWith" in v ? typeof r[k] === "string" && r[k].startsWith(v.startsWith) : "gte" in v ? +r[k] >= +v.gte : true) : r[k] === v);
  const prisma = { automationEvent: { findMany: vi.fn(async (a: any) => { calls.push(a); return ROWS.filter((r) => match(r, a.where)).sort((x, y) => +y.receivedAt - +x.receivedAt).slice(0, a.take).map((r: any) => Object.fromEntries(Object.keys(a.select).filter((k) => a.select[k]).map((k) => [k, r[k]]))); }) } };
  return { prisma, calls };
}
const ids = async (q: any) => (await queryOperatorEvents(fake().prisma, q)).map((r) => r.id);

describe("consulta administrativa de eventos (operadores)", () => {
  it("needs_review: todos os que requerem análise, de todas as organizações e os sem organização", async () => {
    expect((await ids({ kind: "needs_review" })).sort()).toEqual(["nr-A", "nr-B", "nr-sem-org"]);
  });
  it("dropped: inclui o que o painel do cliente não mostra", async () => {
    expect((await ids({ kind: "dropped" })).sort()).toEqual(["drop-A", "drop-sem-org"]);
  });
  it("no_org: só eventos SEM organização (os que nenhum cliente enxerga), de qualquer razão", async () => {
    expect((await ids({ kind: "no_org" })).sort()).toEqual(["drop-sem-org", "ign-sem-org", "nr-sem-org"]);
  });
  it("com --org, devolve SÓ aquela organização: nunca eventos de outra nem sem organização", async () => {
    expect((await ids({ kind: "needs_review", organizationId: "A" }))).toEqual(["nr-A"]);
    expect((await ids({ kind: "needs_review", organizationId: "B" }))).toEqual(["nr-B"]);
    expect((await ids({ kind: "all", organizationId: "A" })).sort()).toEqual(["drop-A", "nr-A", "ok-A"]);
  });
  it("no_org combinado com --org é recusado (não faria sentido e poderia trazer dados de uma organização)", async () => {
    await expect(queryOperatorEvents(fake().prisma, { kind: "no_org", organizationId: "A" })).rejects.toThrow(/não pode ser combinado/);
    expect(opsWhere({ kind: "no_org" })).toEqual({ organizationId: null });
  });
  it("NUNCA seleciona nem devolve payload, texto, autor ou IDs da Meta", async () => {
    const f = fake(); const rows = await queryOperatorEvents(f.prisma, { kind: "all" });
    expect(f.calls[0].select.payload).toBeUndefined();
    expect(Object.keys(f.calls[0].select).sort()).toEqual(["error", "id", "igAccountId", "organizationId", "receivedAt", "socialAccountId", "status"]);
    expect(JSON.stringify(rows)).not.toMatch(/SEGREDO|usuario_secreto|payload|providerEventKey/);
    expect(Object.keys(rows[0]).sort()).toEqual(["hasIgAccountId", "id", "kind", "organizationId", "reason", "receivedAt", "socialAccountId", "state", "status"]);
  });
  it("traz o código da razão e se o evento tem conta identificada", async () => {
    const r = (await queryOperatorEvents(fake().prisma, { kind: "needs_review" })).find((x) => x.id === "nr-sem-org")!;
    expect(r).toMatchObject({ reason: "needs_review.ig_account_missing", state: "needs_review", organizationId: null, hasIgAccountId: false });
  });
  it("filtra por data e limita o tamanho (1 a 200)", async () => {
    expect(await ids({ kind: "all", since: new Date("2026-11-05T00:00:00Z") })).not.toContain("ok-A");
    expect((await ids({ kind: "all", limit: 2 })).length).toBe(2);
    const f = fake(); await queryOperatorEvents(f.prisma, { limit: 99999 }); expect(f.calls[0].take).toBe(200);
    await queryOperatorEvents(f.prisma, { limit: -5 }); expect(f.calls[1].take).toBe(1);
  });
  it("parseSince entende 30m, 24h, 7d e datas; ignora lixo", () => {
    expect(parseSince("24h", NOW)).toEqual(new Date("2026-11-08T12:00:00Z"));
    expect(parseSince("7d", NOW)).toEqual(new Date("2026-11-02T12:00:00Z"));
    expect(parseSince("30m", NOW)).toEqual(new Date("2026-11-09T11:30:00Z"));
    expect(parseSince("2026-11-01", NOW)).toEqual(new Date("2026-11-01T00:00:00Z"));
    expect(parseSince("abc", NOW)).toBeUndefined();
    expect(parseSince(undefined, NOW)).toBeUndefined();
  });
});
