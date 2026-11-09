// Corridas entre webhook, worker e retenção, em PostgreSQL REAL e de forma DETERMINÍSTICA (barreiras explícitas; nenhum teste depende
// de sorte de tempo). A Meta é SEMPRE um mock que conta as chamadas; nenhum envio real.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { encryptToken } from "@dabi/config";
import { handleCommentJob } from "../job-handler";
import type { Deps } from "../process-comment";
import { REQUIRED, PG_URL, missingInfra } from "../test-infra";
import { purgeCommentUnit, purgeCommentUnitTx } from "./purge";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (corridas de retenção)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });

const KEY = Buffer.alloc(32, 3).toString("base64");
const NOW = new Date("2026-11-09T12:00:00Z");
const run = `rc${Date.now()}`;
const TTL = 180 * 86400;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(Boolean(missing))("corridas webhook × worker × retenção (PostgreSQL real, determinístico)", () => {
  const prisma = new PrismaClient({ datasourceUrl: PG_URL });
  let orgId = "", dmAuto = "", pubAuto = "", bothAuto = "";
  let n = 0;

  const mkMeta = () => {
    const calls = { sends: 0, replies: 0, reads: 0 };
    const fetchImpl = (async (u: any) => {
      const url = String(u);
      if (url.includes("/messages")) { calls.sends++; return new Response(JSON.stringify({ recipient_id: "r", message_id: "m" }), { status: 200 }); }
      if (url.includes("/replies")) { calls.replies++; return new Response(JSON.stringify({ id: "reply" }), { status: 200 }); }
      calls.reads++; return new Response(JSON.stringify({ timestamp: new Date(NOW.getTime() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 });
    }) as any;
    return { calls, fetchImpl };
  };
  const mkDeps = (fetchImpl: any, p: any = prisma): Deps => ({ prisma: p, now: () => NOW, env: { sendEnabled: true, resumeEnabled: false, publicReplyEnabled: true, graphVersion: "v23.0", encryptionKey: KEY }, fetchImpl });

  /** Após a leitura do tombstone feita pelo worker no início, espera a barreira (o worker já "viu" que não havia tombstone). */
  const pauseAfterTombstoneRead = (real: PrismaClient, barrier: Promise<void>, reached: () => void) => {
    let first = true;
    return new Proxy(real as any, {
      get(t, m: string) {
        const d = t[m];
        if (m !== "idempotencyTombstone") return typeof d === "function" ? d.bind(t) : d;
        return new Proxy(d, { get(dd, op: string) { const fn = dd[op]; if (op !== "findUnique" || typeof fn !== "function") return typeof fn === "function" ? fn.bind(dd) : fn; return async (...a: any[]) => { const r = await fn.apply(dd, a); if (first) { first = false; reached(); await barrier; } return r; }; } });
      },
    }) as PrismaClient;
  };

  const newComment = async (auto: string, mediaSuffix: string) => {
    const cid = `${run}-c${++n}`;
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-${mediaSuffix}` } } } } });
    return { cid, ev, auto };
  };
  const deliveries = (cid: string) => prisma.messageDelivery.findMany({ where: { commentId: cid } });
  const replies = (cid: string) => prisma.publicReply.findMany({ where: { commentId: cid } });
  const tomb = (cid: string) => prisma.idempotencyTombstone.findUnique({ where: { commentId: cid } });

  /** Estado "antigo" de um comentário já tratado: evento PROCESSED + entrega (e, se pedido, resposta pública). */
  const oldState = async (cid: string, autoId: string, dmStatus: "SENT" | "UNKNOWN" | "FAILED", withReply: boolean) => {
    await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "PROCESSED", payload: { field: "comments", value: { id: cid, text: "LINK", media: { id: `${run}-m` } } } } }).catch(() => {});
    await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: autoId, commentId: cid, status: dmStatus, attempts: 1 } });
    if (withReply) await prisma.publicReply.create({ data: { organizationId: orgId, automationId: autoId, commentId: cid, status: "SENT", attempts: 1 } });
  };
  const eventKeys: string[] = [];

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `test ${run}` } });
    orgId = org.id;
    const enc = encryptToken("EAAPRtesttoken", KEY);
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: `${run}-ig`, username: "t", credential: { create: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK" } } } });
    const mk = async (suffix: string, extra: any) => { const m = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: `${run}-${suffix}` } }); return (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: m.id, keyword: "LINK", replyMessage: "Oi", status: "ACTIVE", ...extra } })).id; };
    dmAuto = await mk("m", {});
    pubAuto = await mk("mp", { dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "Prontinho!" });
    bothAuto = await mk("mb", { publicReplyEnabled: true, publicReplyMessage: "Prontinho!" });
  });

  afterAll(async () => {
    await prisma.automationEvent.deleteMany({ where: { providerEventKey: { startsWith: `comment:${run}` } } });
    await prisma.idempotencyTombstone.deleteMany({ where: { commentId: { startsWith: run } } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  // ──────────────── o cenário dos 5 passos (lado worker) ────────────────
  it("passos 1–5: tombstone ausente na verificação → retenção exclui e cria o tombstone → ingestão conclui (novo evento) → worker processa: NENHUM envio", async () => {
    const meta = mkMeta();
    const cid = `${run}-passos`;
    await oldState(cid, dmAuto, "UNKNOWN", false); // resultado desconhecido: nunca pode virar envio nem "não enviada"
    // 1) webhook verifica: sem tombstone (a retenção ainda não rodou)
    expect(await tomb(cid)).toBeNull();
    // 2–3) retenção exclui evento e registros e cria o tombstone, na MESMA transação
    const purged = await purgeCommentUnitTx(prisma, cid, { event: true, records: true }, TTL);
    expect(purged).toMatchObject({ events: 1, deliveries: 1, replies: 0 });
    expect(await tomb(cid)).not.toBeNull();
    // 4) a ingestão (que tinha verificado ANTES) conclui: cria o evento novo e enfileira
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-m` } } } } });
    // 5) o worker tenta processar o evento
    const r = await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(r.outcome).toBe("dropped");
    expect(meta.calls.sends + meta.calls.replies).toBe(0);
    expect(await deliveries(cid)).toHaveLength(0); // nenhuma reserva nova
    const after = await prisma.automationEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(after).toMatchObject({ status: "IGNORED", error: "dropped.tombstone" });
  });

  // ──────────────── worker já passou pela verificação inicial; a retenção confirma ANTES do claim ────────────────
  it("worker passou pela verificação de tombstone; a retenção confirma a exclusão antes do claim: o claim recusa e NÃO há envio (DM)", async () => {
    const meta = mkMeta();
    const { cid, ev } = await newComment(dmAuto, "m");
    // estado antigo do MESMO comentário: entrega UNKNOWN (sem tombstone ainda); o evento atual é o que o worker vai processar
    await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: dmAuto, commentId: cid, status: "UNKNOWN", attempts: 1 } });
    const barrier = gate(); const reached = gate();
    const p = pauseAfterTombstoneRead(prisma, barrier.p, reached.open);
    const job = handleCommentJob(mkDeps(meta.fetchImpl, p), { eventId: ev.id }); // início: lê o tombstone (ausente) e PARA
    await reached.p;
    expect(await tomb(cid)).toBeNull(); // o worker viu "sem tombstone"
    await purgeCommentUnitTx(prisma, cid, { records: true }, TTL); // retenção: apaga a entrega antiga + cria o tombstone
    barrier.open();
    const r = await job; // o worker continua: reserva nova (a antiga sumiu) → claim
    expect(r.outcome).toBe("processed");
    expect(meta.calls.sends).toBe(0); // a barreira atômica do claim impediu o envio
    const d = await deliveries(cid);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "CANCELED", attempts: 0, error: "dropped.tombstone" }); // Meta comprovadamente não chamada
  });

  it("o mesmo para a RESPOSTA PÚBLICA: o claim recusa e nada é publicado", async () => {
    const meta = mkMeta();
    const { cid, ev } = await newComment(pubAuto, "mp");
    await prisma.publicReply.create({ data: { organizationId: orgId, automationId: pubAuto, commentId: cid, status: "UNKNOWN", attempts: 1 } });
    const barrier = gate(); const reached = gate();
    const job = handleCommentJob(mkDeps(meta.fetchImpl, pauseAfterTombstoneRead(prisma, barrier.p, reached.open)), { eventId: ev.id });
    await reached.p;
    await purgeCommentUnitTx(prisma, cid, { records: true }, TTL);
    barrier.open(); await job;
    expect(meta.calls.replies).toBe(0);
    expect((await replies(cid))[0]).toMatchObject({ status: "CANCELED", attempts: 0, error: "dropped.tombstone" });
  });

  // ──────────────── as DUAS modalidades ────────────────
  it("a exclusão cobre DM e resposta pública juntas e o tombstone bloqueia as DUAS na reingestão", async () => {
    const meta = mkMeta();
    const cid = `${run}-duas`;
    await oldState(cid, bothAuto, "SENT", true);
    const out = await purgeCommentUnitTx(prisma, cid, { event: true, records: true }, TTL);
    expect(out).toMatchObject({ events: 1, deliveries: 1, replies: 1 }); // nenhuma modalidade fica para trás
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-mb` } } } } });
    expect((await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id })).outcome).toBe("dropped");
    expect(meta.calls.sends).toBe(0); expect(meta.calls.replies).toBe(0);
    expect(await deliveries(cid)).toHaveLength(0); expect(await replies(cid)).toHaveLength(0);
  });

  it("purgar só o EVENTO (as duas respostas permanecem): a reingestão não envia nada nem pela unicidade nem pelo tombstone", async () => {
    const meta = mkMeta();
    const cid = `${run}-so-evento`;
    await oldState(cid, bothAuto, "SENT", true);
    await purgeCommentUnitTx(prisma, cid, { event: true }, TTL);
    expect((await deliveries(cid))).toHaveLength(1); expect((await replies(cid))).toHaveLength(1);
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-mb` } } } } });
    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(meta.calls.sends).toBe(0); expect(meta.calls.replies).toBe(0);
  });

  it("resultado DESCONHECIDO nunca vira envio: com UNKNOWN antigo apagado e tombstone válido, a reingestão é descartada", async () => {
    const meta = mkMeta();
    const cid = `${run}-desconhecido`;
    await oldState(cid, dmAuto, "UNKNOWN", false);
    await purgeCommentUnitTx(prisma, cid, { event: true, records: true }, TTL);
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", media: { id: `${run}-m` } } } } });
    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(meta.calls.sends).toBe(0);
    expect((await deliveries(cid)).filter((d) => d.status === "SENT")).toHaveLength(0);
  });

  it("tombstone EXPIRADO não protege (limite documentado): a reingestão é tratada como comentário novo", async () => {
    const meta = mkMeta();
    const cid = `${run}-expirado`;
    await prisma.idempotencyTombstone.create({ data: { commentId: cid, expiresAt: new Date("2026-01-01T00:00:00Z") } }); // no passado para o relógio simulado do worker E para o relógio do banco
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, status: "RECEIVED", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-m` } } } } });
    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(meta.calls.sends).toBe(1); // sem proteção válida, é um comentário novo
  });

  it("o tombstone nunca é ENCURTADO por uma exclusão posterior (GREATEST)", async () => {
    const cid = `${run}-greatest`;
    await purgeCommentUnitTx(prisma, cid, { records: true }, 400 * 86400);
    const longo = (await tomb(cid))!.expiresAt;
    await purgeCommentUnitTx(prisma, cid, { records: true }, 10 * 86400); // TTL menor depois
    expect(+(await tomb(cid))!.expiresAt).toBe(+longo);
  });

  it("a exclusão é atômica: se algo falha depois do tombstone, NADA fica gravado nem apagado", async () => {
    const cid = `${run}-atomica`;
    await oldState(cid, dmAuto, "SENT", false);
    await expect(prisma.$transaction(async (tx: any) => {
      await purgeCommentUnit(tx, cid, { event: true, records: true }, TTL);
      throw new Error("falha injetada depois das exclusões");
    })).rejects.toThrow(/falha injetada/);
    expect(await tomb(cid)).toBeNull(); // o tombstone foi desfeito junto
    expect(await deliveries(cid)).toHaveLength(1); // e nada foi apagado
    expect(await prisma.automationEvent.count({ where: { providerEventKey: `comment:${cid}` } })).toBe(1);
  });
});
