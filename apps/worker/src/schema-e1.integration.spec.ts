// E1 (retenção e exclusão): migrações aditivas e novos estados, em PostgreSQL REAL.
// Só roda com TEST_DATABASE_URL (banco descartável):
//   TEST_DATABASE_URL=postgresql://dabi:dabi@localhost:5440/dabi_test pnpm --filter @dabi/worker test
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

const url = process.env.TEST_DATABASE_URL;
const run = `e1${Date.now()}`;

describe.skipIf(!url)("E1: schema aditivo em PostgreSQL real", () => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  let orgId = "";
  let accountId = "";
  let automationId = "";

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: `${run}-org` } });
    orgId = org.id;
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: `${run}-ig`, username: `${run}_user` } });
    accountId = acc.id;
    const media = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: accountId, providerMediaId: `${run}-media` } });
    const auto = await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: accountId, mediaId: media.id, keyword: "k", replyMessage: "m" } });
    automationId = auto.id;
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({ where: { id: orgId } }); // cascata limpa o resto
    await prisma.deletionRequest.deleteMany({ where: { confirmationCode: { startsWith: run } } });
    await prisma.idempotencyTombstone.deleteMany({ where: { commentId: { startsWith: run } } });
    await prisma.$disconnect();
  });

  describe("campos de desconexão, exclusão pendente e metaUserId", () => {
    it("organização e conta novas nascem sem nenhum marcador de exclusão ou desconexão", async () => {
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org.deletionRequestedAt).toBeNull();
      expect(org.deletionScheduledFor).toBeNull();
      expect(org.deletionCanceledAt).toBeNull();
      expect(org.deletionRequestedById).toBeNull();
      const acc = await prisma.socialAccount.findUniqueOrThrow({ where: { id: accountId } });
      expect(acc.disconnectedAt).toBeNull();
    });

    it("credencial nasce com metaUserId nulo e o campo é opcional (credenciais existentes não são preenchidas)", async () => {
      const c = await prisma.socialCredential.create({ data: { socialAccountId: accountId, encryptedToken: "x", tokenIv: "i", tokenTag: "t", scopes: [] } });
      expect(c.metaUserId).toBeNull();
      expect(c.status).toBe("ACTIVE");
    });

    it("aceita gravar os marcadores (sem que nada os leia ainda) e a busca por metaUserId usa o campo novo", async () => {
      const when = new Date("2026-12-09T12:00:00Z");
      await prisma.organization.update({ where: { id: orgId }, data: { deletionRequestedAt: new Date("2026-11-09T12:00:00Z"), deletionScheduledFor: when, deletionRequestedById: "u-interno" } });
      const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
      expect(org.deletionScheduledFor?.toISOString()).toBe(when.toISOString());
      await prisma.organization.update({ where: { id: orgId }, data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionRequestedById: null } });

      await prisma.socialAccount.update({ where: { id: accountId }, data: { disconnectedAt: when } });
      await prisma.socialAccount.update({ where: { id: accountId }, data: { disconnectedAt: null } });

      await prisma.socialCredential.update({ where: { socialAccountId: accountId }, data: { metaUserId: `${run}-meta` } });
      const found = await prisma.socialCredential.findMany({ where: { metaUserId: `${run}-meta` } });
      expect(found).toHaveLength(1);
    });
  });

  describe("tombstone de idempotência", () => {
    it("guarda só o ID do comentário e rejeita um segundo tombstone do mesmo comentário", async () => {
      const exp = new Date("2027-05-08T12:00:00Z");
      const t = await prisma.idempotencyTombstone.create({ data: { commentId: `${run}-t1`, expiresAt: exp } });
      expect(Object.keys(t).sort()).toEqual(["commentId", "createdAt", "expiresAt", "id"]);
      await expect(prisma.idempotencyTombstone.create({ data: { commentId: `${run}-t1`, expiresAt: exp } })).rejects.toThrow();
      expect(await prisma.idempotencyTombstone.count({ where: { commentId: `${run}-t1` } })).toBe(1);
    });

    it("permite varrer os expirados pelo índice de expiração", async () => {
      await prisma.idempotencyTombstone.create({ data: { commentId: `${run}-t-velho`, expiresAt: new Date("2020-01-01T00:00:00Z") } });
      const velhos = await prisma.idempotencyTombstone.findMany({ where: { commentId: { startsWith: run }, expiresAt: { lt: new Date("2026-11-09T00:00:00Z") } } });
      expect(velhos.map((x) => x.commentId)).toEqual([`${run}-t-velho`]);
    });
  });

  describe("DeletionRequest", () => {
    it("nasce REQUESTED, com código de confirmação único e chave de idempotência única (quando informada)", async () => {
      const a = await prisma.deletionRequest.create({ data: { kind: "META_CALLBACK", confirmationCode: `${run}-cod1`, idempotencyKey: `${run}-idem1` } });
      expect(a.status).toBe("REQUESTED");
      expect(a.completedAt).toBeNull();
      await expect(prisma.deletionRequest.create({ data: { kind: "ORG_DELETE", confirmationCode: `${run}-cod1` } })).rejects.toThrow();
      await expect(prisma.deletionRequest.create({ data: { kind: "META_CALLBACK", confirmationCode: `${run}-cod2`, idempotencyKey: `${run}-idem1` } })).rejects.toThrow();
      // sem idempotencyKey, vários pedidos convivem (NULL não colide)
      await prisma.deletionRequest.create({ data: { kind: "ACCOUNT_DISCONNECT", confirmationCode: `${run}-cod3` } });
      await prisma.deletionRequest.create({ data: { kind: "ACCOUNT_DISCONNECT", confirmationCode: `${run}-cod4` } });
    });

    it("sobrevive à exclusão da organização e do usuário: organizationId/requestedById não têm chave estrangeira", async () => {
      const org = await prisma.organization.create({ data: { name: `${run}-org-efemera` } });
      const req = await prisma.deletionRequest.create({ data: { kind: "ORG_DELETE", confirmationCode: `${run}-cod5`, organizationId: org.id, requestedById: "usuario-que-nao-existe" } });
      await prisma.organization.delete({ where: { id: org.id } });
      const depois = await prisma.deletionRequest.findUniqueOrThrow({ where: { id: req.id } });
      expect(depois.organizationId).toBe(org.id);
      expect(depois.requestedById).toBe("usuario-que-nao-existe");
    });

    it("não tem coluna para dado pessoal: só IDs internos, HMAC e contagens", async () => {
      const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'DeletionRequest' ORDER BY column_name`;
      expect(cols.map((c) => c.column_name)).toEqual(["completedAt", "confirmationCode", "error", "id", "idempotencyKey", "kind", "organizationId", "requestedAt", "requestedById", "scheduledFor", "status", "subjectHmac", "summary", "updatedAt"]);
    });
  });

  describe("índices de retenção", () => {
    it("existem os índices que a futura varredura vai usar", async () => {
      const rows = await prisma.$queryRaw<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
      const nomes = rows.map((r) => r.indexname);
      for (const n of ["AuditLog_createdAt_idx", "AutomationEvent_receivedAt_idx", "Invitation_expiresAt_idx", "MessageDelivery_status_updatedAt_idx", "PublicReply_status_updatedAt_idx", "IdempotencyTombstone_expiresAt_idx", "SocialCredential_metaUserId_idx"]) expect(nomes).toContain(n);
    });
  });

  describe("estado CANCELED", () => {
    it("aceita CANCELED em MessageDelivery e PublicReply, sem mudar o padrão PENDING", async () => {
      const d = await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId, commentId: `${run}-c1`, status: "CANCELED", error: "teste" } });
      const r = await prisma.publicReply.create({ data: { organizationId: orgId, automationId, commentId: `${run}-c1`, status: "CANCELED" } });
      expect(d.status).toBe("CANCELED");
      expect(r.status).toBe("CANCELED");
      const padrao = await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId, commentId: `${run}-c2` } });
      expect(padrao.status).toBe("PENDING");
      expect(padrao.attempts).toBe(0);
    });

    it("não conta CANCELED como retomável: a consulta da retomada (HELD, attempts 0) a ignora", async () => {
      const held = await prisma.messageDelivery.findMany({ where: { organizationId: orgId, status: "HELD", attempts: 0 } });
      expect(held.map((x) => x.commentId)).not.toContain(`${run}-c1`);
    });
  });
});
