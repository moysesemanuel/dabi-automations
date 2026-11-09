// E3: tabelas RetentionRun e RetentionLease (aditivas) em PostgreSQL REAL descartável.
import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { REQUIRED, PG_URL, missingInfra } from "../test-infra";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (retention schema)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });
const run = `rs${Date.now()}`;

describe.skipIf(Boolean(missing))("E3: RetentionRun e RetentionLease", () => {
  const prisma = new PrismaClient({ datasourceUrl: PG_URL });
  afterAll(async () => {
    await prisma.retentionRun.deleteMany({ where: { error: { startsWith: run } } });
    await prisma.retentionLease.deleteMany({ where: { id: { startsWith: run } } });
    await prisma.$disconnect();
  });

  it("RetentionRun nasce RUNNING, sem dado operacional, e guarda só modo, limites, contagens e erro", async () => {
    const r = await prisma.retentionRun.create({ data: { mode: "DRY_RUN", limits: { batch: 10 }, counts: { events: 3 }, error: `${run}-x` } });
    expect(r.status).toBe("RUNNING");
    expect(r.finishedAt).toBeNull();
    const cols = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'RetentionRun' ORDER BY column_name`;
    expect(cols.map((c) => c.column_name)).toEqual(["counts", "error", "finishedAt", "id", "leaseEpoch", "limits", "mode", "startedAt", "status"]);
  });

  it("RetentionLease: linha singleton por id, epoch 0, sem dono e sem validade", async () => {
    const l = await prisma.retentionLease.create({ data: { id: `${run}-lease` } });
    expect(l).toMatchObject({ owner: null, epoch: 0, leaseUntil: null, heartbeatAt: null });
    await expect(prisma.retentionLease.create({ data: { id: `${run}-lease` } })).rejects.toThrow(); // id único: não há duas travas
  });

  it("as tabelas novas nascem vazias de efeito: nenhuma alteração em eventos, entregas, respostas ou tombstones", async () => {
    const [e, d, p, t] = await Promise.all([prisma.automationEvent.count({ where: { providerEventKey: { startsWith: `comment:${run}` } } }), prisma.messageDelivery.count({ where: { commentId: { startsWith: run } } }), prisma.publicReply.count({ where: { commentId: { startsWith: run } } }), prisma.idempotencyTombstone.count({ where: { commentId: { startsWith: run } } })]);
    expect([e, d, p, t]).toEqual([0, 0, 0, 0]);
  });
});
