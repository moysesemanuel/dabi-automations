// Corridas entre execuções simultâneas do MESMO comentário, em PostgreSQL REAL, de forma DETERMINÍSTICA (barreiras, sem
// depender de sorte de tempo). A Meta é sempre um mock. Regressão de um achado do CI: uma execução que chegava depois
// gravava UNKNOWN por cima de um SENT já gravado (leitura antiga + update incondicional).
//   TEST_DATABASE_URL=postgresql://dabi:dabi@localhost:5440/dabi_test pnpm --filter @dabi/worker test
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { encryptToken } from "@dabi/config";
import { handleCommentJob } from "./job-handler";
import type { Deps } from "./process-comment";
import { PG_URL, REQUIRED, missingInfra } from "./test-infra";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (corridas)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}: no CI os testes de integração são obrigatórios`); }); });

const KEY = Buffer.alloc(32, 5).toString("base64");
const NOW = new Date("2026-11-09T12:00:00Z");
const run = `r${Date.now()}`;

/** Promessa que se resolve quando alguém chama `open()`. */
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(Boolean(missing))("corridas entre execuções do mesmo comentário (PostgreSQL real, determinístico)", () => {
  const prisma = new PrismaClient({ datasourceUrl: PG_URL });
  let orgId = "", dmAutoId = "", pubAutoId = "";
  const eventIds: string[] = [];
  let n = 0;

  const mkMeta = () => {
    const calls = { messages: 0, replies: 0 };
    const hold = gate(); // segura a resposta da DM (simula a execução A "em voo")
    const started = gate();
    const fetchImpl = (async (u: any) => {
      const url = String(u);
      if (url.includes("/messages")) { calls.messages++; started.open(); await hold.p; return new Response(JSON.stringify({ recipient_id: "r", message_id: "m" }), { status: 200 }); }
      if (url.includes("/replies")) { calls.replies++; return new Response(JSON.stringify({ id: "reply" }), { status: 200 }); }
      return new Response(JSON.stringify({ timestamp: new Date(NOW.getTime() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 });
    }) as any;
    return { calls, hold, started, fetchImpl };
  };
  const mkDeps = (fetchImpl: any, p: any = prisma): Deps => ({ prisma: p, now: () => NOW, env: { sendEnabled: true, resumeEnabled: false, publicReplyEnabled: true, graphVersion: "v23.0", encryptionKey: KEY }, fetchImpl });

  /** Prisma em que a leitura de `model.findUnique` devolve um retrato ANTIGO: só é entregue quando a barreira abrir. */
  const withStaleRead = (real: PrismaClient, model: "messageDelivery" | "publicReply", barrier: Promise<void>) =>
    new Proxy(real as any, {
      get(t, m: string) {
        const d = t[m];
        if (m !== model) return typeof d === "function" ? d.bind(t) : d;
        return new Proxy(d, {
          get(dd, op: string) {
            const fn = dd[op];
            if (op !== "findUnique" || typeof fn !== "function") return typeof fn === "function" ? fn.bind(dd) : fn;
            return async (...args: any[]) => { const snapshot = await fn.apply(dd, args); await barrier; return snapshot; };
          },
        });
      },
    }) as PrismaClient;

  const mkEvent = async () => {
    const cid = `${run}-c${++n}`;
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-m` } } } } });
    eventIds.push(ev.id);
    return { cid, ev };
  };
  const mkPubEvent = async () => {
    const cid = `${run}-c${++n}`;
    const ev = await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-mp` } } } } });
    eventIds.push(ev.id);
    return { cid, ev };
  };

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `test ${run}` } });
    orgId = org.id;
    const enc = encryptToken("EAAPRtesttoken", KEY);
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: `${run}-ig`, username: "t", credential: { create: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK" } } } });
    const m1 = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: `${run}-m` } });
    dmAutoId = (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: m1.id, keyword: "LINK", replyMessage: "Oi", status: "ACTIVE" } })).id;
    const m2 = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: `${run}-mp` } });
    pubAutoId = (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: m2.id, keyword: "LINK", replyMessage: "Oi", dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "Prontinho!", status: "ACTIVE" } })).id;
  });

  afterAll(async () => {
    await prisma.automationEvent.deleteMany({ where: { id: { in: eventIds } } });
    if (orgId) await prisma.organization.delete({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  it("A está ENVIANDO (em voo) e B chega: nenhuma chamada extra à Meta e, quando A termina, o estado final é SENT", async () => {
    const meta = mkMeta();
    const { cid, ev } = await mkEvent();
    const A = handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    await meta.started.p; // A reivindicou (PENDING, attempts 1) e está dentro da chamada à Meta
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: cid } }))).toMatchObject({ status: "PENDING", attempts: 1 });

    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id }); // B chega e termina antes de A
    expect(meta.calls.messages).toBe(1); // B NÃO chamou a Meta

    meta.hold.open(); // A recebe a resposta da Meta
    await A;
    const final = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: cid } });
    expect(final).toMatchObject({ status: "SENT", attempts: 1 }); // o resultado de A prevalece
    expect(meta.calls.messages).toBe(1);
    expect(await prisma.messageDelivery.count({ where: { commentId: cid } })).toBe(1);
  });

  it("B tem uma leitura ANTIGA (PENDING, attempts 1) e só escreve DEPOIS de A gravar SENT: NÃO rebaixa para UNKNOWN", async () => {
    const meta = mkMeta();
    const { cid, ev } = await mkEvent();
    const A = handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    await meta.started.p;

    const barrier = gate();
    const B = handleCommentJob(mkDeps(meta.fetchImpl, withStaleRead(prisma, "messageDelivery", barrier.p)), { eventId: ev.id });
    await sleep(150); // B já leu o retrato antigo (PENDING, attempts 1) e está parada na barreira

    meta.hold.open(); await A; // A termina e grava SENT
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: cid } })).status).toBe("SENT");

    barrier.open(); await B; // B continua com o retrato antigo: o compare-and-set deve falhar
    const final = await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: cid } });
    expect(final).toMatchObject({ status: "SENT", attempts: 1 });
    expect(final.error).toBeNull();
    expect(meta.calls.messages).toBe(1);
    const e = await prisma.automationEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(e.status).toBe("PROCESSED");
    expect(e.error ?? "").not.toMatch(/UNKNOWN|interrompido/); // B também não deixou nota enganosa no evento
  });

  it("processo caiu de verdade (PENDING, attempts 1, ninguém em voo): continua UNKNOWN e sem chamada à Meta", async () => {
    const meta = mkMeta();
    const { cid, ev } = await mkEvent();
    await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: dmAutoId, commentId: cid, status: "PENDING", attempts: 1 } });
    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(meta.calls.messages).toBe(0);
    expect(await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: cid } })).toMatchObject({ status: "UNKNOWN", attempts: 1 });
  });

  it("resposta pública: leitura antiga (PENDING, attempts 1) e a linha já está SENT: NÃO é rebaixada e a Meta não é chamada", async () => {
    const meta = mkMeta();
    const { cid, ev } = await mkPubEvent();
    const row = await prisma.publicReply.create({ data: { organizationId: orgId, automationId: pubAutoId, commentId: cid, status: "PENDING", attempts: 1 } });
    const barrier = gate();
    const B = handleCommentJob(mkDeps(meta.fetchImpl, withStaleRead(prisma, "publicReply", barrier.p)), { eventId: ev.id });
    await sleep(150); // B leu PENDING/attempts 1 e está parada
    await prisma.publicReply.update({ where: { id: row.id }, data: { status: "SENT", providerResponse: { id: "reply-da-outra-execucao" } } });
    barrier.open(); await B;
    expect(await prisma.publicReply.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: "SENT", attempts: 1 });
    expect(meta.calls.replies).toBe(0);
  });

  it("resposta pública: caiu de verdade (PENDING, attempts 1, ninguém em voo): UNKNOWN e sem chamada", async () => {
    const meta = mkMeta();
    const { cid, ev } = await mkPubEvent();
    await prisma.publicReply.create({ data: { organizationId: orgId, automationId: pubAutoId, commentId: cid, status: "PENDING", attempts: 1 } });
    await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id });
    expect(meta.calls.replies).toBe(0);
    expect(await prisma.publicReply.findUniqueOrThrow({ where: { commentId: cid } })).toMatchObject({ status: "UNKNOWN", attempts: 1 });
  });
});
