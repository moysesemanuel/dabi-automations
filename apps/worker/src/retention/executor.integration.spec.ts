// Executor da retenção em um banco PostgreSQL DESCARTÁVEL próprio (criado e migrado do zero; removido no fim). Nenhum dado de
// desenvolvimento é tocado. Nenhuma chamada à Meta.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { REQUIRED, missingInfra, createDisposableDatabase } from "../test-infra";
import { runRetention, type LedgerLike } from "./executor";
import { LEASE_ID, acquireLease } from "./lease";
import type { RetentionPlan } from "./authorization";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (executor)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });

type Plan = Extract<RetentionPlan, { ok: true }>;
const plan = (mode: "dry-run" | "execute", batchSize = 10, maxRows = 100): Plan => ({ ok: true, mode, batchSize, maxRows });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const D = (n: number) => n * 86400; // dias em segundos
let seq = 0;

describe.skipIf(Boolean(missing))("executor da retenção (PostgreSQL descartável)", () => {
  let db: Awaited<ReturnType<typeof createDisposableDatabase>>;
  let prisma: PrismaClient; let other: PrismaClient;
  let orgId = "", autoId = "";
  const deps = (extra: any = {}) => ({ prisma, now: () => new Date(), owner: `t${++seq}`, leaseTtlSeconds: 30, heartbeatEveryMs: 1000, ...extra });

  beforeAll(async () => {
    db = await createDisposableDatabase("e3exec");
    prisma = new PrismaClient({ datasourceUrl: db.url });
    other = new PrismaClient({ datasourceUrl: db.url });
    orgId = (await prisma.organization.create({ data: { name: "org" } })).id;
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: "ig", username: "t" } });
    const media = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: "m" } });
    autoId = (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: media.id, keyword: "LINK", replyMessage: "Oi" } })).id;
  }, 120_000);
  afterAll(async () => { await prisma?.$disconnect(); await other?.$disconnect(); await db?.drop(); });
  beforeEach(async () => {
    for (const m of ["automationEvent", "messageDelivery", "publicReply", "idempotencyTombstone", "invitation", "auditLog", "retentionRun", "retentionLease"] as const) await (prisma as any)[m].deleteMany({});
  });

  // ── construção de dados (as idades são aplicadas por SQL, sem depender do relógio)
  type U = { event?: { status?: string; error?: string | null; days: number }; dm?: { status: string; attempts?: number; secs: number; createdSecs?: number }; pub?: { status: string; attempts?: number; secs: number } };
  const mk = async (cid: string, u: U) => {
    if (u.event) {
      await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, status: (u.event.status ?? "PROCESSED") as any, error: u.event.error ?? null, payload: { field: "comments", value: { id: cid } } } });
      await prisma.$executeRaw`UPDATE "AutomationEvent" SET "receivedAt" = NOW() - make_interval(secs => ${D(u.event.days)}) WHERE "providerEventKey" = ${`comment:${cid}`}`;
    }
    for (const [model, r] of [["MessageDelivery", u.dm], ["PublicReply", u.pub]] as const) if (r) {
      const create = model === "MessageDelivery" ? prisma.messageDelivery.create : prisma.publicReply.create;
      await (create as any).call(model === "MessageDelivery" ? prisma.messageDelivery : prisma.publicReply, { data: { organizationId: orgId, automationId: autoId, commentId: cid, status: r.status, attempts: r.attempts ?? 1 } });
      const created = (r as any).createdSecs ?? r.secs;
      await prisma.$executeRawUnsafe(`UPDATE "${model}" SET "createdAt" = NOW() - make_interval(secs => ${created}), "updatedAt" = NOW() - make_interval(secs => ${r.secs}) WHERE "commentId" = '${cid}'`);
    }
  };
  const evCount = () => prisma.automationEvent.count(); const dmCount = () => prisma.messageDelivery.count(); const pubCount = () => prisma.publicReply.count();
  const tomb = (c: string) => prisma.idempotencyTombstone.findUnique({ where: { commentId: c } });
  const dmOf = (c: string) => prisma.messageDelivery.findUnique({ where: { commentId: c } });
  const TABLES = ["AutomationEvent", "MessageDelivery", "PublicReply", "IdempotencyTombstone", "Invitation", "AuditLog", "Organization", "SocialAccount", "SocialCredential", "Automation", "Media", "User", "Membership", "ConnectionOnboarding", "DeletionRequest", "RetentionLease"];
  const fingerprint = async () => { const out: Record<string, string> = {}; for (const t of TABLES) { const r: any[] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n, md5(coalesce(string_agg(r::text, '|' ORDER BY r::text), '')) AS h FROM "${t}" r`); out[t] = `${r[0].n}:${r[0].h}`; } return out; };

  /** Conjunto de dados que exercita todas as regras. */
  const dataset = async () => {
    await mk("a-evento-velho", { event: { status: "IGNORED", error: "conta desconhecida", days: 40 } });
    await mk("b-held-velho", { event: { days: 40 }, dm: { status: "HELD", attempts: 0, secs: D(35), createdSecs: D(35) } });
    await mk("c-pending0", { dm: { status: "PENDING", attempts: 0, secs: 20 * 60 } });
    await mk("c-pending1", { dm: { status: "PENDING", attempts: 1, secs: 20 * 60 } });
    await mk("d-unknown-velho", { dm: { status: "UNKNOWN", attempts: 1, secs: D(100) } });
    await mk("e-duas", { dm: { status: "SENT", secs: D(100) }, pub: { status: "UNKNOWN", secs: D(100) } });
    await mk("f-so-uma-velha", { dm: { status: "SENT", secs: D(100) }, pub: { status: "SENT", secs: D(80) } });
    await mk("g-em-voo", { dm: { status: "PENDING", attempts: 1, secs: 5 * 60 } });
    await mk("h-recente", { event: { days: 2 }, dm: { status: "SENT", secs: D(1) } });
  };

  // ────────────────────────── DRY_RUN ──────────────────────────
  it("DRY_RUN não altera NENHUM dado operacional (impressão digital de todas as tabelas idêntica); só grava o RetentionRun", async () => {
    await dataset();
    const antes = await fingerprint();
    const r = await runRetention(deps(), plan("dry-run"));
    expect(r.status).toBe("COMPLETED");
    expect(r.mode).toBe("DRY_RUN");
    expect(await fingerprint()).toEqual(antes); // eventos, entregas, respostas, tombstones, convites, auditoria, org, contas, credenciais...
    expect(await prisma.idempotencyTombstone.count()).toBe(0); // nenhum tombstone operacional
    expect(await prisma.retentionLease.count()).toBe(0); // nem trava: nada a proteger
    expect(await prisma.auditLog.count()).toBe(0); // dry-run nem audita (único efeito administrativo é o RetentionRun)
    const runs = await prisma.retentionRun.findMany();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ mode: "DRY_RUN", status: "COMPLETED" });
    expect(JSON.stringify(runs[0].counts)).not.toMatch(/comment|c-pending|d-unknown/); // sem IDs de comentário
  });

  it("o relatório do DRY_RUN é exatamente o que a execução faz (mesma seleção e mesmo planejamento)", async () => {
    await dataset();
    const dry = await runRetention(deps(), plan("dry-run"));
    const real = await runRetention(deps(), plan("execute"));
    expect(real.status).toBe("COMPLETED");
    for (const k of ["transitionsCanceled", "transitionsUnknown", "closedReview", "purgedEvents", "purgedDeliveries", "purgedReplies"] as const) expect(real.counts.rows[k], k).toBe(dry.counts.rows[k]);
    expect(real.counts.actions).toEqual(dry.counts.actions);
    expect(dry.counts.rows.transitionsCanceled).toBeGreaterThan(0);
  });

  // ────────────────────────── EXECUTE: regras por estado ──────────────────────────
  it("rodada 1: estados presos primeiro (PENDING attempts 0 → CANCELED, attempts ≥ 1 → UNKNOWN, HELD velha → CANCELED) e exclusões do que já é seguro", async () => {
    await dataset();
    const r = await runRetention(deps(), plan("execute"));
    expect(r.status).toBe("COMPLETED");
    expect((await dmOf("c-pending0"))!.status).toBe("CANCELED"); // a Meta nunca foi chamada
    expect((await dmOf("c-pending1"))!.status).toBe("UNKNOWN"); // pode ter chamado: NUNCA CANCELED
    expect((await dmOf("b-held-velho"))!.status).toBe("CANCELED");
    expect(await tomb("b-held-velho")).toBeNull(); // transição e exclusão NÃO ocorrem na mesma rodada
    expect((await dmOf("g-em-voo"))!.status).toBe("PENDING"); // em voo recente: intocada
    expect((await dmOf("g-em-voo"))!.attempts).toBe(1);
    expect(await dmOf("f-so-uma-velha")).not.toBeNull(); // uma modalidade nunca sai sozinha
    expect(await dmOf("h-recente")).not.toBeNull();
    // exclusões seguras da rodada 1:
    expect(await prisma.automationEvent.count({ where: { providerEventKey: "comment:a-evento-velho" } })).toBe(0);
    expect(await tomb("a-evento-velho")).not.toBeNull();
    expect(await dmOf("d-unknown-velho")).toBeNull(); // UNKNOWN > 90 d encerrado (com tombstone)
    expect(await tomb("d-unknown-velho")).not.toBeNull();
    expect(await dmOf("e-duas")).toBeNull(); expect(await prisma.publicReply.findUnique({ where: { commentId: "e-duas" } })).toBeNull(); // as duas modalidades JUNTAS
    expect(await tomb("e-duas")).not.toBeNull();
  });

  it("rodada 2 exclui o evento da HELD cancelada; UNKNOWN nunca virou CANCELED em nenhuma rodada", async () => {
    await dataset();
    await runRetention(deps(), plan("execute"));
    await runRetention(deps(), plan("execute"));
    expect(await prisma.automationEvent.count({ where: { providerEventKey: "comment:b-held-velho" } })).toBe(0);
    expect(await tomb("b-held-velho")).not.toBeNull();
    expect(await dmOf("b-held-velho")).not.toBeNull(); // a entrega CANCELED fica até os 90 dias
    expect((await dmOf("c-pending1"))!.status).toBe("UNKNOWN");
    expect(await prisma.messageDelivery.count({ where: { status: "CANCELED", commentId: "c-pending1" } })).toBe(0);
  });

  it("cada execução é auditada (retention.run) e tem RetentionRun com a trava usada; a trava é liberada no fim", async () => {
    await dataset();
    const r = await runRetention(deps(), plan("execute"));
    expect(await prisma.auditLog.count({ where: { action: "retention.run", entityId: r.runId } })).toBe(1);
    const run = await prisma.retentionRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(run).toMatchObject({ mode: "EXECUTE", status: "COMPLETED" });
    expect(run.leaseEpoch).toBeGreaterThanOrEqual(1);
    expect((await prisma.retentionLease.findUniqueOrThrow({ where: { id: LEASE_ID } })).owner).toBeNull();
  });

  // ────────────────────────── lotes e limites ──────────────────────────
  it("lote ≤ 10 linhas e teto por execução: 25 eventos antigos com teto 15 ⇒ no máximo 15 linhas e nenhum lote acima de 10; a próxima execução continua", async () => {
    for (let i = 0; i < 25; i++) await mk(`lote-${String(i).padStart(2, "0")}`, { event: { days: 40 } });
    const r = await runRetention(deps(), plan("execute", 10, 15));
    expect(r.counts.rows.purgedEvents).toBeLessThanOrEqual(15);
    expect(r.counts.capped).toBe(true);
    expect(Math.max(...r.batches)).toBeLessThanOrEqual(10);
    expect(await evCount()).toBe(25 - r.counts.rows.purgedEvents);
    const r2 = await runRetention(deps(), plan("execute", 10, 100));
    expect(await evCount()).toBe(0);
    expect(r.counts.rows.purgedEvents + r2.counts.rows.purgedEvents).toBe(25);
    expect(await prisma.idempotencyTombstone.count()).toBe(25); // um tombstone por comentário, sem duplicar
  });

  it("lote de 3 linhas: cada transação respeita o limite", async () => {
    for (let i = 0; i < 9; i++) await mk(`pequeno-${i}`, { event: { days: 40 } });
    const r = await runRetention(deps(), plan("execute", 3, 100));
    expect(r.batches.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...r.batches)).toBeLessThanOrEqual(3);
  });

  // ────────────────────────── atomicidade ──────────────────────────
  it("falha no meio do lote desfaz o lote INTEIRO (tombstones e exclusões); a rodada seguinte, sem falha, conclui", async () => {
    for (let i = 0; i < 4; i++) await mk(`atom-${i}`, { dm: { status: "SENT", secs: D(100) } });
    let calls = 0;
    const faulty = new Proxy(prisma as any, { get(t, m: string) { const d = t[m]; if (m === "$transaction") return (fn: any, o: any) => t.$transaction((tx: any) => fn(new Proxy(tx, { get(tt, mm: string) { const dd = tt[mm]; if (mm !== "messageDelivery") return typeof dd === "function" ? dd.bind(tt) : dd; return new Proxy(dd, { get(x, op: string) { const f = x[op]; if (op === "deleteMany" && typeof f === "function") return (...a: any[]) => { if (++calls === 2) throw new Error("falha injetada no meio do lote"); return f.apply(x, a); }; return typeof f === "function" ? f.bind(x) : f; } }); } })), o); return typeof d === "function" ? d.bind(t) : d; } });
    const r = await runRetention(deps({ prisma: faulty }), plan("execute", 10, 100));
    expect(r.status).toBe("FAILED");
    expect(await dmCount()).toBe(4); // nada foi apagado
    expect(await prisma.idempotencyTombstone.count()).toBe(0); // e nenhum tombstone ficou
    const ok = await runRetention(deps(), plan("execute", 10, 100));
    expect(ok.status).toBe("COMPLETED");
    expect(await dmCount()).toBe(0);
    expect(await prisma.idempotencyTombstone.count()).toBe(4);
  });

  // ────────────────────────── concorrência com o processamento ──────────────────────────
  it("estado muda ENTRE a seleção e a execução (execução em voo): a unidade NÃO é apagada e as demais seguem", async () => {
    await mk("voo-1", { dm: { status: "SENT", secs: D(100) } });
    await mk("voo-2", { dm: { status: "SENT", secs: D(100) } });
    const r = await runRetention(deps({ hooks: { afterSelect: async () => { await prisma.$executeRaw`UPDATE "MessageDelivery" SET "status" = 'PENDING', "attempts" = 1, "updatedAt" = NOW() WHERE "commentId" = 'voo-1'`; } } }), plan("execute"));
    expect(r.counts.skipped.stale).toBe(1);
    expect(await dmOf("voo-1")).toMatchObject({ status: "PENDING", attempts: 1 }); // intocada
    expect(await tomb("voo-1")).toBeNull();
    expect(await dmOf("voo-2")).toBeNull();
    expect(await tomb("voo-2")).not.toBeNull();
  });

  it("um evento novo chega depois da seleção: o executor re-avalia sobre as linhas travadas e ADIA (não apaga as entregas antigas)", async () => {
    await mk("chegou-evento", { dm: { status: "SENT", secs: D(100) } });
    const r = await runRetention(deps({ hooks: { afterSelect: async () => { await prisma.automationEvent.create({ data: { providerEventKey: "comment:chegou-evento", status: "RECEIVED", payload: {} } }); } } }), plan("execute"));
    expect(r.counts.skipped.stale).toBe(1);
    expect(await dmOf("chegou-evento")).not.toBeNull();
    expect(await tomb("chegou-evento")).toBeNull();
  });

  it("linha travada por outra execução (FOR UPDATE): o executor NÃO espera nem apaga; adia e conclui", async () => {
    await mk("travada", { dm: { status: "SENT", secs: D(100) } });
    await mk("livre", { dm: { status: "SENT", secs: D(100) } });
    const hold = new Promise<void>((res) => setTimeout(res, 2500));
    let locked!: () => void; const ready = new Promise<void>((r) => (locked = r));
    const worker = other.$transaction(async (tx: any) => { await tx.$queryRaw`SELECT "id" FROM "MessageDelivery" WHERE "commentId" = 'travada' FOR UPDATE`; locked(); await hold; }, { timeout: 10_000 });
    await ready;
    const t0 = Date.now();
    const r = await runRetention(deps(), plan("execute"));
    expect(Date.now() - t0).toBeLessThan(2000); // não esperou a linha travada
    expect(r.counts.skipped.busy).toBe(1);
    expect(await dmOf("travada")).not.toBeNull();
    expect(await dmOf("livre")).toBeNull();
    await worker;
  });

  // ────────────────────────── trava ──────────────────────────
  it("duas execuções simultâneas: uma conclui, a outra é ABORTADA sem alterar nada; nada é apagado duas vezes", async () => {
    for (let i = 0; i < 12; i++) await mk(`duas-${String(i).padStart(2, "0")}`, { event: { days: 40 } });
    const [a, b] = await Promise.all([runRetention(deps(), plan("execute", 5, 100)), runRetention(deps({ prisma: other }), plan("execute", 5, 100))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["ABORTED", "COMPLETED"]);
    const aborted = a.status === "ABORTED" ? a : b;
    expect(aborted.counts.rows.purgedEvents).toBe(0);
    expect(await evCount()).toBe(0);
    expect(await prisma.idempotencyTombstone.count()).toBe(12);
  });

  it("trava tomada por outra instância: a execução é ABORTADA e não altera dados", async () => {
    await mk("trava-alheia", { event: { days: 40 } });
    await acquireLease(other, "outra-instancia", 60);
    const r = await runRetention(deps(), plan("execute"));
    expect(r.status).toBe("ABORTED");
    expect(r.abortReason).toMatch(/trava/);
    expect(await evCount()).toBe(1);
  });

  it("trava perdida ENTRE lotes: o próximo lote aborta sem alterar nada; o lote já confirmado permanece (atômico)", async () => {
    for (let i = 0; i < 8; i++) await mk(`perda-${i}`, { event: { days: 40 } });
    let txCount = 0;
    const proxied = new Proxy(prisma as any, { get(t, m: string) { const d = t[m]; if (m !== "$transaction") return typeof d === "function" ? d.bind(t) : d; return async (fn: any, o: any) => { const res = await t.$transaction(fn, o); if (++txCount === 1) { await t.$executeRaw`UPDATE "RetentionLease" SET "leaseUntil" = NOW() - interval '1 second' WHERE "id" = ${LEASE_ID}`; await acquireLease(other, "tomou", 60); } return res; }; } });
    const r = await runRetention(deps({ prisma: proxied }), plan("execute", 3, 100));
    expect(["ABORTED", "PARTIAL"]).toContain(r.status);
    expect(r.counts.rows.purgedEvents).toBe(3); // só o primeiro lote
    expect(await evCount()).toBe(5);
    expect(await prisma.idempotencyTombstone.count()).toBe(3); // consistente com o que foi apagado
  });

  it("pausa instantânea: com isPaused verdadeiro, nenhum lote roda", async () => {
    await mk("pausa", { event: { days: 40 } });
    await runRetention(deps({ isPaused: async () => true }), plan("execute"));
    expect(await evCount()).toBe(1);
  });

  // ────────────────────────── registro durável ──────────────────────────
  it("falha do registro durável bloqueia as EXCLUSÕES, mas não as transições de estado", async () => {
    await mk("led-excluir", { dm: { status: "SENT", secs: D(100) } });
    await mk("led-cancelar", { dm: { status: "PENDING", attempts: 0, secs: 20 * 60 } });
    const ledger: LedgerLike = { intent: async () => { throw new Error("armazenamento indisponível"); }, done: async () => {} };
    const r = await runRetention(deps({ ledger }), plan("execute"));
    expect(r.counts.skipped.ledgerBlocked).toBe(1);
    expect(await dmOf("led-excluir")).not.toBeNull(); expect(await tomb("led-excluir")).toBeNull();
    expect((await dmOf("led-cancelar"))!.status).toBe("CANCELED"); // a transição não depende do fornecedor externo
  });

  // ────────────────────────── needs_review ──────────────────────────
  it("needs_review: 30 d de análise, 90 d de retenção, encerramento explícito ANTES da exclusão e nunca indefinido", async () => {
    await mk("nr-novo", { event: { status: "RECEIVED", error: "needs_review.association_mismatch", days: 10 } });
    await mk("nr-atrasado", { event: { status: "RECEIVED", error: "needs_review.association_mismatch", days: 35 } });
    await mk("nr-vencido", { event: { status: "RECEIVED", error: "needs_review.association_mismatch", days: 95 } });
    const r1 = await runRetention(deps(), plan("execute"));
    expect(r1.counts.actions.overdue_review).toBe(1);
    expect(r1.counts.rows.closedReview).toBe(1);
    expect(r1.counts.rows.purgedEvents).toBe(0); // encerra, mas NÃO exclui na mesma rodada
    const vencido = await prisma.automationEvent.findUniqueOrThrow({ where: { providerEventKey: "comment:nr-vencido" } });
    expect(vencido).toMatchObject({ status: "IGNORED", error: "dropped.review_expired" });
    expect(await evCount()).toBe(3); // nenhum excluído ainda
    const r2 = await runRetention(deps(), plan("execute"));
    expect(r2.counts.rows.purgedEvents).toBe(1); // só o encerrado
    expect(await prisma.automationEvent.count({ where: { providerEventKey: { in: ["comment:nr-novo", "comment:nr-atrasado"] } } })).toBe(2); // os dentro do prazo permanecem
    expect(await tomb("nr-vencido")).not.toBeNull();
  });

  // ────────────────────────── demais categorias ──────────────────────────
  it("tombstones expirados, convites encerrados, auditoria e execuções antigas são removidos pelas regras; o que está no prazo permanece", async () => {
    await prisma.idempotencyTombstone.create({ data: { commentId: "t-expirado", expiresAt: new Date(Date.now() - 1000) } });
    await prisma.idempotencyTombstone.create({ data: { commentId: "t-valido", expiresAt: new Date(Date.now() + 86400_000) } });
    const mkInv = (email: string, over: any) => prisma.invitation.create({ data: { organizationId: orgId, email, role: "MEMBER", tokenHash: email, expiresAt: new Date(Date.now() + 86400_000 * 30), ...over } });
    await mkInv("aceito-velho@x", { acceptedAt: new Date(Date.now() - 10 * 86400_000) });
    await mkInv("aceito-novo@x", { acceptedAt: new Date(Date.now() - 2 * 86400_000) });
    await mkInv("pendente@x", {});
    await mkInv("expirado@x", { expiresAt: new Date(Date.now() - 9 * 86400_000) });
    const old = await prisma.auditLog.create({ data: { action: "x.velho" } }); const rec = await prisma.auditLog.create({ data: { action: "x.novo" } });
    await prisma.$executeRaw`UPDATE "AuditLog" SET "createdAt" = NOW() - make_interval(secs => ${D(200)}) WHERE "id" = ${old.id}`;
    const oldRun = await prisma.retentionRun.create({ data: { mode: "DRY_RUN", status: "COMPLETED" } });
    await prisma.$executeRaw`UPDATE "RetentionRun" SET "startedAt" = NOW() - make_interval(secs => ${D(400)}) WHERE "id" = ${oldRun.id}`;
    const r = await runRetention(deps(), plan("execute"));
    expect(r.counts.rows).toMatchObject({ tombstonesExpired: 1, invitations: 2, auditLogs: 1, retentionRuns: 1 });
    expect(await prisma.idempotencyTombstone.findMany({ select: { commentId: true } })).toEqual([{ commentId: "t-valido" }]);
    expect((await prisma.invitation.findMany({ select: { email: true }, orderBy: { email: "asc" } })).map((i) => i.email)).toEqual(["aceito-novo@x", "pendente@x"]);
    expect(await prisma.auditLog.findUnique({ where: { id: rec.id } })).not.toBeNull();
    expect(await prisma.auditLog.findUnique({ where: { id: old.id } })).toBeNull();
  });

  it("sem dados elegíveis (ou tudo no prazo), nada muda e a execução conclui", async () => {
    await mk("novo", { event: { days: 1 }, dm: { status: "SENT", secs: D(1) } });
    const antes = await fingerprint();
    const r = await runRetention(deps(), plan("execute"));
    expect(r.status).toBe("COMPLETED");
    const depois = await fingerprint();
    expect({ ...depois, AuditLog: antes.AuditLog, RetentionLease: antes.RetentionLease }).toEqual(antes); // só a auditoria da execução e a trava mudam
  });
});
