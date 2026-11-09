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
    await prisma.$disconnect();
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
