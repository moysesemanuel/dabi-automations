// Trava de execução da retenção em PostgreSQL REAL: duas instâncias, expiração, fencing e interrupção no meio de um lote.
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { REQUIRED, PG_URL, missingInfra } from "../test-infra";
import { LeaseLostError, acquireLease, assertLeaseInTx, releaseLease, renewLease, startHeartbeat } from "./lease";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (lease)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(Boolean(missing))("trava de retenção (arrendamento com fencing)", () => {
  const ID = `lease-test-${Date.now()}`; // id próprio: não disputa a linha singleton de produção com outros arquivos de teste
  // A trava é um singleton de BANCO: estes testes usam o banco descartável e o limpam a cada teste.
  const prisma = new PrismaClient({ datasourceUrl: PG_URL });
  const other = new PrismaClient({ datasourceUrl: PG_URL }); // segunda "instância" (outra conexão)
  const reset = () => prisma.retentionLease.deleteMany({ where: { id: ID } });
  beforeEach(reset);
  afterAll(async () => { await reset(); await prisma.$disconnect(); await other.$disconnect(); });
  const expireNow = () => prisma.$executeRaw`UPDATE "RetentionLease" SET "leaseUntil" = NOW() - interval '1 second' WHERE "id" = ${ID}`;
  const row = () => prisma.retentionLease.findUniqueOrThrow({ where: { id: ID } });

  it("duas instâncias disputando AO MESMO TEMPO: exatamente uma adquire", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => acquireLease(i % 2 ? prisma : other, `inst-${i}`, 30, ID)));
    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.epoch).toBe(1);
    expect((await row()).owner).toBe(winners[0]!.owner);
  });

  it("enquanto a trava é válida, outra instância não adquire; depois de liberada, adquire com epoch maior", async () => {
    const a = (await acquireLease(prisma, "A", 30, ID))!;
    expect(await acquireLease(other, "B", 30, ID)).toBeNull();
    expect(await releaseLease(prisma, a)).toBe(true);
    const b = (await acquireLease(other, "B", 30, ID))!;
    expect(b.epoch).toBe(a.epoch + 1);
  });

  it("expiração: outra instância adquire; o dono antigo NÃO renova, NÃO passa no fencing e NÃO libera a trava do novo dono", async () => {
    const a = (await acquireLease(prisma, "A", 30, ID))!;
    await expireNow();
    const b = (await acquireLease(other, "B", 30, ID))!;
    expect(b.epoch).toBe(a.epoch + 1);
    expect(await renewLease(prisma, a, 30)).toBe(false); // perdida: quem chama deve abortar
    await expect(prisma.$transaction((tx: any) => assertLeaseInTx(tx, a))).rejects.toBeInstanceOf(LeaseLostError);
    expect(await releaseLease(prisma, a)).toBe(false); // verifica posse: não solta a trava de B
    expect((await row()).owner).toBe("B");
    expect(await renewLease(other, b, 30)).toBe(true); // B continua dono e renova
  });

  it("trava expirada mas ainda não tomada NÃO é renovável (conservador): o dono atrasado aborta", async () => {
    const a = (await acquireLease(prisma, "A", 30, ID))!;
    await expireNow();
    expect(await renewLease(prisma, a, 30)).toBe(false);
    await expect(prisma.$transaction((tx: any) => assertLeaseInTx(tx, a))).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("fencing: validade expira NO MEIO do lote, mas a tomada ESPERA o lote terminar (FOR SHARE); o lote confirma e só depois o outro adquire", async () => {
    const a = (await acquireLease(prisma, "A", 1, ID))!; // 1 s de validade
    let batchDone = false; let bResult: any = "pendente";
    const batch = prisma.$transaction(async (tx: any) => {
      await assertLeaseInTx(tx, a); // início do lote: válida
      await sleep(1600); // a validade expira durante o lote
      batchDone = true;
      return "lote-confirmado";
    }, { timeout: 10_000 });
    await sleep(1300); // já expirou; B tenta tomar
    const b = acquireLease(other, "B", 30, ID).then((h) => (bResult = h));
    await sleep(200);
    expect(bResult).toBe("pendente"); // B está BLOQUEADO enquanto o lote de A não termina
    expect(await batch).toBe("lote-confirmado");
    await b;
    expect(batchDone).toBe(true);
    expect(bResult).toMatchObject({ owner: "B", epoch: a.epoch + 1 });
  });

  it("interrupção no meio de um lote (queda do worker): a transação é desfeita e a trava só volta a ser tomada depois de expirar", async () => {
    const a = (await acquireLease(prisma, "A", 30, ID))!;
    await prisma.retentionRun.create({ data: { mode: "EXECUTE", error: "lease-teste" } });
    await expect(prisma.$transaction(async (tx: any) => {
      await assertLeaseInTx(tx, a);
      await tx.retentionRun.updateMany({ where: { error: "lease-teste" }, data: { status: "COMPLETED" } });
      throw new Error("queda simulada no meio do lote");
    })).rejects.toThrow(/queda simulada/);
    expect((await prisma.retentionRun.findFirstOrThrow({ where: { error: "lease-teste" } })).status).toBe("RUNNING"); // nada foi gravado
    expect(await acquireLease(other, "B", 30, ID)).toBeNull(); // o dono "morreu", mas a trava só libera ao expirar
    await expireNow();
    expect(await acquireLease(other, "B", 30, ID)).not.toBeNull();
    await prisma.retentionRun.deleteMany({ where: { error: "lease-teste" } });
  });

  it("o heartbeat renova em segundo plano e avisa quando a trava é perdida", async () => {
    const a = (await acquireLease(prisma, "A", 2, ID))!;
    let lost = ""; const hb = startHeartbeat(prisma, a, 2, (why) => (lost = why), 300);
    await sleep(2600); // mais que a validade inicial: só passa se renovou
    expect(lost).toBe("");
    expect(await acquireLease(other, "B", 30, ID)).toBeNull(); // continua do A
    await expireNow(); // simula perda (outra instância toma)
    await acquireLease(other, "B", 30, ID);
    await sleep(700);
    expect(lost).toMatch(/recusada|erro/);
    hb.stop();
  });

  it("liberação normal devolve a trava e zera o dono e a validade", async () => {
    const a = (await acquireLease(prisma, "A", 30, ID))!;
    expect(await releaseLease(prisma, a)).toBe(true);
    expect(await row()).toMatchObject({ owner: null, leaseUntil: null });
  });
});
