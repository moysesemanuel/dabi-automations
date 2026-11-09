// Corrida entre a INGESTÃO do webhook e a retenção, em PostgreSQL REAL, determinística (barreira). Sem Meta, sem Redis: a fila é um fake.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@dabi/database";
import { randomUUID } from "node:crypto";
import { WebhooksService } from "./webhooks.service";

const PG = process.env.TEST_DATABASE_URL;
const REQUIRED = process.env.REQUIRE_INTEGRATION === "1" || process.env.CI === "true";
if (REQUIRED && !PG) describe("infraestrutura obrigatória (corrida de ingestão)", () => { it("precisa de TEST_DATABASE_URL", () => { throw new Error("falta TEST_DATABASE_URL"); }); });

const run = `ri${Date.now()}`;
const gate = () => { let open!: () => void; const p = new Promise<void>((r) => (open = r)); return { p, open }; };

describe.skipIf(!PG)("corrida ingestão × retenção (PostgreSQL real, determinístico)", () => {
  const prisma = new PrismaClient({ datasourceUrl: PG });
  let orgId = "", accId = "", autoId = "";

  /** Exclusão da retenção para um comentário: tombstone + exclusões na MESMA transação (mesma regra da primitiva do worker). */
  const purge = (cid: string) => prisma.$transaction(async (tx: any) => {
    await tx.$executeRaw`INSERT INTO "IdempotencyTombstone" ("id","commentId","createdAt","expiresAt") VALUES (${randomUUID()}, ${cid}, NOW(), NOW() + make_interval(secs => ${180 * 86400})) ON CONFLICT ("commentId") DO UPDATE SET "expiresAt" = GREATEST("IdempotencyTombstone"."expiresAt", EXCLUDED."expiresAt")`;
    await tx.automationEvent.deleteMany({ where: { providerEventKey: `comment:${cid}` } });
    await tx.messageDelivery.deleteMany({ where: { commentId: cid } });
    await tx.publicReply.deleteMany({ where: { commentId: cid } });
  });
  const body = (cid: string) => ({ object: "instagram", entry: [{ id: `${run}-ig`, changes: [{ field: "comments", value: { id: cid, text: "LINK", from: { id: "u1" }, media: { id: `${run}-m` } } }] }] });
  const mkSvc = (format: "legacy" | "minimal", pausedPrisma?: any) => {
    const added: any[] = [];
    const svc: any = new WebhooksService((pausedPrisma ?? prisma) as any, { format });
    svc._queue = { add: async (...a: any[]) => { added.push(a); } };
    return { svc: svc as WebhooksService, added };
  };
  /** Pausa a ingestão logo DEPOIS da primeira leitura de tombstone (que devolveu "ausente"). */
  const pauseAfterTombstoneRead = (barrier: Promise<void>, reached: () => void) => {
    let first = true;
    return new Proxy(prisma as any, {
      get(t, m: string) {
        const d = t[m];
        if (m !== "idempotencyTombstone") return typeof d === "function" ? d.bind(t) : d;
        return new Proxy(d, { get(dd, op: string) { const fn = dd[op]; if (op !== "findUnique" || typeof fn !== "function") return typeof fn === "function" ? fn.bind(dd) : fn; return async (...a: any[]) => { const r = await fn.apply(dd, a); if (first) { first = false; reached(); await barrier; } return r; }; } });
      },
    });
  };

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `test ${run}` } });
    orgId = org.id;
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: `${run}-ig`, username: "t", credential: { create: { encryptedToken: "x", tokenIv: "i", tokenTag: "t", loginMode: "FACEBOOK" } } } });
    accId = acc.id;
    const media = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: accId, providerMediaId: `${run}-m` } });
    autoId = (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: accId, mediaId: media.id, keyword: "LINK", replyMessage: "Oi" } })).id;
  });
  afterAll(async () => {
    await prisma.automationEvent.deleteMany({ where: { providerEventKey: { startsWith: `comment:${run}` } } });
    await prisma.idempotencyTombstone.deleteMany({ where: { commentId: { startsWith: run } } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  });

  for (const format of ["legacy", "minimal"] as const) {
    it(`[${format}] passos 1–4: ingestão vê 'sem tombstone' → retenção exclui e cria o tombstone → ingestão conclui: o evento novo vira IGNORED e NADA é enfileirado`, async () => {
      const cid = `${run}-${format}-passos`;
      // estado: só restou uma entrega antiga (UNKNOWN); não há evento (a ingestão vai criá-lo)
      await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: autoId, commentId: cid, status: "UNKNOWN", attempts: 1 } });
      const barrier = gate(); const reached = gate();
      const { svc, added } = mkSvc(format, pauseAfterTombstoneRead(barrier.p, reached.open));
      const ingest = svc.ingest(body(cid)); // 1) lê o tombstone (ausente) e PARA
      await reached.p;
      expect(await prisma.idempotencyTombstone.findUnique({ where: { commentId: cid } })).toBeNull();
      await purge(cid); // 2–3) a retenção exclui a entrega e cria o tombstone, atomicamente
      barrier.open();
      await ingest; // 4) a ingestão tenta concluir
      const ev = await prisma.automationEvent.findUniqueOrThrow({ where: { providerEventKey: `comment:${cid}` } });
      expect(ev).toMatchObject({ status: "IGNORED", error: "dropped.tombstone" });
      expect(added).toHaveLength(0); // nenhum job: o worker nem precisa ser chamado
    });
  }

  it("sem corrida: tombstone já existente impede a criação do evento e o job", async () => {
    const cid = `${run}-sem-corrida`;
    await purge(cid);
    const { svc, added } = mkSvc("minimal");
    await svc.ingest(body(cid));
    expect(await prisma.automationEvent.count({ where: { providerEventKey: `comment:${cid}` } })).toBe(0);
    expect(added).toHaveLength(0);
  });

  it("comentário novo, sem tombstone: a ingestão segue normal (evento RECEIVED e job enfileirado): compatibilidade", async () => {
    const cid = `${run}-novo`;
    const { svc, added } = mkSvc("minimal");
    await svc.ingest(body(cid));
    const ev = await prisma.automationEvent.findUniqueOrThrow({ where: { providerEventKey: `comment:${cid}` } });
    expect(ev).toMatchObject({ status: "RECEIVED", igAccountId: `${run}-ig` });
    expect(added).toHaveLength(1);
    expect(added[0][1]).toEqual({ eventId: ev.id });
  });
});
