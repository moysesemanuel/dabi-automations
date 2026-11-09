// Teste de integração com PostgreSQL REAL. Só roda com TEST_DATABASE_URL (banco descartável):
//   TEST_DATABASE_URL=postgresql://dabi:dabi@localhost:5440/dabi_test pnpm --filter @dabi/worker test
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { encryptToken } from "@dabi/config";
import { processCommentEvent, resumePending, type Deps } from "./process-comment";
import { REQUIRED, missingInfra } from "./test-infra";

const url = process.env.TEST_DATABASE_URL;
const KEY = Buffer.alloc(32, 9).toString("base64");
const NOW = new Date("2026-11-07T12:00:00Z");
const run = `it${Date.now()}`;

const missing = missingInfra({ pg: true });
// No CI (ou REQUIRE_INTEGRATION=1) a infraestrutura é obrigatória: se faltar, o teste FALHA em vez de ser pulado.
if (REQUIRED && missing) describe("infraestrutura obrigatória (concorrência)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}: no CI os testes de integração são obrigatórios`); }); });

describe.skipIf(Boolean(missing))("concorrência em PostgreSQL real", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  let orgId = "";
  const eventIds: string[] = [];

  const mkDeps = (sendEnabled: boolean, sends: string[], publicEnabled = false): Deps => ({
    prisma, now: () => NOW,
    env: { sendEnabled, resumeEnabled: true, publicReplyEnabled: publicEnabled, graphVersion: "v23.0", encryptionKey: KEY },
    fetchImpl: (async (u: any) => {
      if (String(u).includes("/replies")) {
        sends.push(String(u));
        await new Promise((r) => setTimeout(r, 50));
        return new Response(JSON.stringify({ id: "reply1" }), { status: 200 });
      }
      if (String(u).includes("/messages")) {
        sends.push(String(u));
        await new Promise((r) => setTimeout(r, 50)); // alarga a janela da corrida
        return new Response(JSON.stringify({ recipient_id: "r", message_id: "m" }), { status: 200 });
      }
      return new Response(JSON.stringify({ timestamp: new Date(NOW.getTime() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 });
    }) as any,
  });

  const mkEvent = async (commentId: string, mediaSuffix = "m") => {
    const ev = await prisma.automationEvent.create({
      data: { providerEventKey: `comment:${commentId}`, payload: { field: "comments", value: { id: commentId, text: "LINK", media: { id: `${run}-${mediaSuffix}` }, from: { id: "u1" } } } },
    });
    eventIds.push(ev.id);
    return { eventId: ev.id, igAccountId: `${run}-ig`, commentId, mediaId: `${run}-${mediaSuffix}`, text: "LINK", fromId: "u1" };
  };

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `test ${run}` } });
    orgId = org.id;
    const enc = encryptToken("EAAPRtesttoken", KEY);
    const acc = await prisma.socialAccount.create({
      data: { organizationId: orgId, providerAccountId: `${run}-ig`, username: "t", credential: { create: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK" } } },
    });
    const media = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: `${run}-m` } });
    await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: media.id, keyword: "LINK", replyMessage: "Oi", status: "ACTIVE" } });
    const media2 = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: `${run}-m2` } });
    await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: media2.id, keyword: "LINK", replyMessage: "Oi", status: "ACTIVE", publicReplyEnabled: true, publicReplyMessage: "Prontinho!" } });
  });

  afterAll(async () => {
    await prisma.automationEvent.deleteMany({ where: { id: { in: eventIds } } });
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }); // cascata: conta, mídia, automação, entregas
    await prisma.$disconnect();
  });

  it("6 execuções simultâneas do mesmo comentário novo: exatamente 1 envio", async () => {
    const sends: string[] = [];
    const deps = mkDeps(true, sends);
    const job = await mkEvent(`${run}-c1`);
    await Promise.all(Array.from({ length: 6 }, () => processCommentEvent(deps, job)));
    expect(sends).toHaveLength(1);
    const d = await prisma.messageDelivery.findMany({ where: { commentId: `${run}-c1` } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("job do BullMQ + resumePending + reentrega de webhook ao mesmo tempo: exatamente 1 envio", async () => {
    const sends: string[] = [];
    const job = await mkEvent(`${run}-c2`);
    await processCommentEvent(mkDeps(false, sends), job); // nasce HELD com envio desligado
    expect(sends).toHaveLength(0);

    const held = await prisma.messageDelivery.findUnique({ where: { commentId: `${run}-c2` } });
    expect(held?.status).toBe("HELD");
    const on = mkDeps(true, sends);
    await Promise.all([
      processCommentEvent(on, job),
      processCommentEvent(on, job),
      resumePending(on),
      resumePending(on),
    ]);
    expect(sends).toHaveLength(1);
    const d = await prisma.messageDelivery.findUnique({ where: { commentId: `${run}-c2` } });
    expect(d).toMatchObject({ status: "SENT", attempts: 1 });
  });

  it("resposta pública: 6 execuções simultâneas => 1 DM e 1 resposta pública (PublicReply SENT com id)", async () => {
    const calls: string[] = [];
    const deps = mkDeps(true, calls, true);
    const job = await mkEvent(`${run}-c3`, "m2");
    await Promise.all(Array.from({ length: 6 }, () => processCommentEvent(deps, job)));
    expect(calls.filter((u) => u.includes("/messages"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/replies"))).toHaveLength(1);
    const pr = await prisma.publicReply.findMany({ where: { commentId: `${run}-c3` } });
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ status: "SENT", attempts: 1, providerResponse: { id: "reply1" } });
  });

  it("resposta pública: reentregas simultâneas depois do envio não publicam de novo", async () => {
    const calls: string[] = [];
    const deps = mkDeps(true, calls, true);
    const job = await mkEvent(`${run}-c4`, "m2");
    await processCommentEvent(deps, job);
    await Promise.all([processCommentEvent(deps, job), processCommentEvent(deps, job), processCommentEvent(deps, job)]);
    expect(calls.filter((u) => u.includes("/replies"))).toHaveLength(1);
    expect(calls.filter((u) => u.includes("/messages"))).toHaveLength(1);
  });

  it("resposta pública: 8 execuções simultâneas com a DM já SENT (queda antes de publicar) => 1 publicação", async () => {
    const calls: string[] = [];
    const deps = mkDeps(true, calls, true);
    const job = await mkEvent(`${run}-c5`, "m2");
    const auto = await prisma.automation.findFirstOrThrow({ where: { organizationId: orgId, publicReplyEnabled: true } });
    await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: auto.id, commentId: `${run}-c5`, status: "SENT", attempts: 1 } });
    await Promise.all(Array.from({ length: 8 }, () => processCommentEvent(deps, job)));
    expect(calls.filter((u) => u.includes("/messages"))).toHaveLength(0); // a DM não repete
    expect(calls.filter((u) => u.includes("/replies"))).toHaveLength(1); // só 1 publicação
    const pr = await prisma.publicReply.findMany({ where: { commentId: `${run}-c5` } });
    expect(pr).toHaveLength(1);
    expect(pr[0]).toMatchObject({ status: "SENT", attempts: 1 });
  });
});
