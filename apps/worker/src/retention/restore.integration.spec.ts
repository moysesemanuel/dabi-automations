// Recuperação após RESTAURAÇÃO de backup (tombstones criados depois do backup) em banco PostgreSQL DESCARTÁVEL. Nenhuma chamada à Meta.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptToken } from "@dabi/config";
import { REQUIRED, missingInfra, createDisposableDatabase } from "../test-infra";
import { handleCommentJob } from "../job-handler";
import { claimReservation } from "../claim";
import type { Deps } from "../process-comment";
import { runRetention } from "./executor";
import { FileLedger } from "./ledger";
import { isRestoreHoldOn, reconcileAndRelease, reconcileFromLedger, setRestoreHold, verifyReconciliation } from "./restore";

const missing = missingInfra({ pg: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (restauração)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });

const KEY = Buffer.alloc(32, 4).toString("base64");
const D = (n: number) => n * 86400;
const plan = { ok: true as const, mode: "execute" as const, batchSize: 10, maxRows: 100 };

describe.skipIf(Boolean(missing))("restauração de backup: reconciliação de tombstones", () => {
  let db: Awaited<ReturnType<typeof createDisposableDatabase>>; let prisma: PrismaClient;
  let dir = ""; let ledgerPath = ""; let orgId = "", autoId = "";
  const TABLES = ["automationEvent", "messageDelivery", "publicReply", "idempotencyTombstone", "retentionRun", "auditLog"] as const;

  beforeAll(async () => {
    db = await createDisposableDatabase("e3rest"); prisma = new PrismaClient({ datasourceUrl: db.url });
    orgId = (await prisma.organization.create({ data: { name: "org" } })).id;
    const enc = encryptToken("EAAPRtesttoken", KEY);
    const acc = await prisma.socialAccount.create({ data: { organizationId: orgId, providerAccountId: "ig", username: "t", credential: { create: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK" } } } });
    const media = await prisma.media.create({ data: { organizationId: orgId, socialAccountId: acc.id, providerMediaId: "m" } });
    autoId = (await prisma.automation.create({ data: { organizationId: orgId, socialAccountId: acc.id, mediaId: media.id, keyword: "LINK", replyMessage: "Oi" } })).id;
  }, 120_000);
  afterAll(async () => { await prisma?.$disconnect(); await db?.drop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  beforeEach(async () => {
    for (const m of [...TABLES, "retentionLease"] as const) await (prisma as any)[m].deleteMany({});
    dir = mkdtempSync(join(tmpdir(), "ledger-")); ledgerPath = join(dir, "tombstones.jsonl");
  });

  const mkUnit = async (cid: string, u: { event?: number; dm?: { status: string; secs: number; attempts?: number }; pub?: { status: string; secs: number } }) => {
    if (u.event) { await prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, status: "PROCESSED", igAccountId: "ig", payload: { field: "comments", value: { id: cid, text: "LINK", media: { id: "m" } } } } }); await prisma.$executeRaw`UPDATE "AutomationEvent" SET "receivedAt" = NOW() - make_interval(secs => ${D(u.event)}) WHERE "providerEventKey" = ${`comment:${cid}`}`; }
    if (u.dm) { await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: autoId, commentId: cid, status: u.dm.status as any, attempts: u.dm.status === "HELD" ? 0 : 1 } }); await prisma.$executeRaw`UPDATE "MessageDelivery" SET "createdAt" = NOW() - make_interval(secs => ${u.dm.secs}), "updatedAt" = NOW() - make_interval(secs => ${u.dm.secs}) WHERE "commentId" = ${cid}`; }
    if (u.pub) { await prisma.publicReply.create({ data: { organizationId: orgId, automationId: autoId, commentId: cid, status: u.pub.status as any, attempts: 1 } }); await prisma.$executeRaw`UPDATE "PublicReply" SET "createdAt" = NOW() - make_interval(secs => ${u.pub.secs}), "updatedAt" = NOW() - make_interval(secs => ${u.pub.secs}) WHERE "commentId" = ${cid}`; }
  };
  const dataset = async () => {
    await mkUnit("rest-a", { event: 40 });
    await mkUnit("rest-b", { event: 40, dm: { status: "SENT", secs: D(100) }, pub: { status: "UNKNOWN", secs: D(100) } });
    await mkUnit("rest-c", { dm: { status: "UNKNOWN", secs: D(100) } });
    await mkUnit("rest-d", { dm: { status: "HELD", secs: D(35) } }); // HELD velha: a retenção a CANCELA (transição de estado)
  };
  const COMMENTS = ["rest-a", "rest-b", "rest-c"];
  /** "Backup": retrato das tabelas operacionais; "restauração": apaga tudo e reinsere o retrato (estado ANTERIOR às exclusões e aos tombstones). */
  const snapshot = async () => { const s: Record<string, any[]> = {}; for (const m of ["automationEvent", "messageDelivery", "publicReply", "idempotencyTombstone"] as const) s[m] = await (prisma as any)[m].findMany(); return s; };
  const restore = async (s: Record<string, any[]>) => { for (const m of [...TABLES, "retentionLease"] as const) await (prisma as any)[m].deleteMany({}); for (const m of ["automationEvent", "messageDelivery", "publicReply", "idempotencyTombstone"] as const) if (s[m].length) await (prisma as any)[m].createMany({ data: s[m] }); };
  const mkDeps = (fetchImpl: any): Deps => ({ prisma, now: () => new Date(), env: { sendEnabled: true, resumeEnabled: false, publicReplyEnabled: true, graphVersion: "v23.0", encryptionKey: KEY }, fetchImpl });
  const mkMeta = () => { const calls = { sends: 0, replies: 0, reads: 0 }; return { calls, fetchImpl: (async (u: any) => { const url = String(u); if (url.includes("/messages")) { calls.sends++; return new Response(JSON.stringify({ recipient_id: "r", message_id: "m" }), { status: 200 }); } if (url.includes("/replies")) { calls.replies++; return new Response(JSON.stringify({ id: "x" }), { status: 200 }); } calls.reads++; return new Response(JSON.stringify({ timestamp: new Date(Date.now() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 }); }) as any }; };
  const newEvent = (cid: string) => prisma.automationEvent.create({ data: { providerEventKey: `comment:${cid}`, status: "RECEIVED", igAccountId: "ig", payload: { field: "comments", value: { id: cid, text: "LINK", from: { id: "u" }, media: { id: "m" } } } } });

  /** Cenário comum: backup → retenção (com ledger) → restauração do backup antigo. */
  const scenario = async () => {
    await dataset();
    const backup = await snapshot();
    const ledger = new FileLedger(ledgerPath);
    const r = await runRetention({ prisma, now: () => new Date(), owner: "t", ledger }, plan);
    expect(r.status).toBe("COMPLETED");
    for (const c of COMMENTS) expect(await prisma.idempotencyTombstone.findUnique({ where: { commentId: c } })).not.toBeNull();
    await restore(backup);
    return { ledger, backup };
  };

  it("o RISCO: depois de restaurar o backup antigo faltam os tombstones e os registros apagados reaparecem; o DRY-RUN não corrige nada disso", async () => {
    const { ledger } = await scenario();
    expect(await prisma.idempotencyTombstone.count()).toBe(0); // proteção perdida
    expect(await prisma.automationEvent.count({ where: { providerEventKey: { in: COMMENTS.map((c) => `comment:${c}`) } } })).toBe(2); // registros ressuscitados
    const dry = await runRetention({ prisma, now: () => new Date(), ledger }, { ...plan, mode: "dry-run" });
    expect(dry.status).toBe("COMPLETED");
    expect(await prisma.idempotencyTombstone.count()).toBe(0); // dry-run nunca cria tombstone: não comprova (nem recupera) as proteções
    const v = await verifyReconciliation(prisma, ledger);
    expect(v.ok).toBe(false);
    expect(v.missingTombstones.sort()).toEqual(COMMENTS);
    expect(v.resurrected.length).toBeGreaterThan(0);
    expect(v.unreappliedTransitions).toEqual(["rest-d"]); // a HELD cancelada voltou a HELD (processável)
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: "rest-d" } })).status).toBe("HELD");
  });

  it("o executor RECUSA executar enquanto o registro durável estiver à frente do banco (restauração não reconciliada)", async () => {
    const { ledger } = await scenario();
    const r = await runRetention({ prisma, now: () => new Date(), ledger }, plan);
    expect(r.status).toBe("ABORTED");
    expect(r.abortReason).toMatch(/reconciliar após restauração/);
  });

  it("bloqueio pós-restauração: nenhum processamento, nenhuma reserva e nenhum envio, mesmo SEM tombstone", async () => {
    await scenario();
    await setRestoreHold(prisma, true);
    expect(await isRestoreHoldOn(prisma)).toBe(true);
    const meta = mkMeta();
    const ev = await newEvent("novo-durante-hold");
    await expect(handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id })).rejects.toThrow(/held:restore-hold/);
    expect(meta.calls.sends + meta.calls.replies + meta.calls.reads).toBe(0); // nem leitura na Meta
    expect(await prisma.messageDelivery.count({ where: { commentId: "novo-durante-hold" } })).toBe(0);
    // e, mesmo que uma reserva já existisse, o claim atômico recusa e a reserva vira HELD (retomável depois)
    const d = await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: autoId, commentId: "reserva-antes", status: "PENDING", attempts: 0 } });
    expect(await claimReservation(prisma, "MessageDelivery", d.id)).toBe(false);
    await setRestoreHold(prisma, false);
    expect(await claimReservation(prisma, "MessageDelivery", d.id)).toBe(true); // liberado: volta ao normal
  });

  it("reconciliação: tombstones recriados, registros ressuscitados reexcluídos, verificação OK e bloqueio liberado; depois, a reingestão é descartada", async () => {
    const { ledger } = await scenario();
    const out = await reconcileAndRelease(prisma, ledger);
    expect(out.verify).toEqual({ ok: true, missingTombstones: [], resurrected: [], unreappliedTransitions: [] });
    expect(out.released).toBe(true);
    expect(await isRestoreHoldOn(prisma)).toBe(false);
    expect(out.reconcile!.tombstonesRecreated).toBe(3);
    expect(out.reconcile!.transitionsReapplied).toBe(1);
    expect((await prisma.messageDelivery.findUniqueOrThrow({ where: { commentId: "rest-d" } })).status).toBe("CANCELED"); // não volta a ser processável
    expect(out.reconcile!.rowsReDeleted.deliveries).toBe(2); expect(out.reconcile!.rowsReDeleted.replies).toBe(1); expect(out.reconcile!.rowsReDeleted.events).toBe(2);
    for (const c of COMMENTS) expect(await prisma.idempotencyTombstone.findUnique({ where: { commentId: c } })).not.toBeNull();
    // reingestão depois da reconciliação: protegida
    const meta = mkMeta(); const ev = await newEvent("rest-b");
    expect((await handleCommentJob(mkDeps(meta.fetchImpl), { eventId: ev.id })).outcome).toBe("dropped");
    expect(meta.calls.sends + meta.calls.replies).toBe(0);
  });

  it("a reconciliação é idempotente: repetir não altera nada", async () => {
    const { ledger } = await scenario();
    await reconcileAndRelease(prisma, ledger);
    const again = await reconcileFromLedger(prisma, ledger);
    expect(again.tombstonesRecreated).toBe(0);
    expect(again.rowsReDeleted).toEqual({ events: 0, deliveries: 0, replies: 0 });
    expect((await verifyReconciliation(prisma, ledger)).ok).toBe(true);
  });

  it("depois de reconciliar, o executor volta a funcionar (o head do banco alcança o do registro)", async () => {
    const { ledger } = await scenario();
    await reconcileAndRelease(prisma, ledger);
    // simula que o banco registrou a última execução conhecida (o RetentionRun foi perdido na restauração; uma execução vazia atualiza o head)
    const head = await ledger.head();
    await prisma.retentionRun.create({ data: { mode: "EXECUTE", status: "COMPLETED", counts: { ledgerHead: head } as any } });
    const r = await runRetention({ prisma, now: () => new Date(), ledger }, plan);
    expect(r.status).toBe("COMPLETED");
  });

  it("adulteração do registro durável (linha alterada) é detectada: a reconciliação RECUSA e o bloqueio permanece ligado", async () => {
    const { ledger } = await scenario();
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    // 1) linha alterada
    const alvo = lines.findIndex((l) => l.includes("rest-a")); expect(alvo).toBeGreaterThanOrEqual(0);
    const adulterada = lines.map((l, i) => (i === alvo ? l.replace(/rest-a/, "rest-z") : l)).join("\n") + "\n";
    writeFileSync(ledgerPath, adulterada);
    expect(() => ledger.read()).toThrow(/adulterado/);
    const out = await reconcileAndRelease(prisma, ledger);
    expect(out.released).toBe(false);
    expect(out.verify.ok).toBe(false);
    expect(out.verify.chainError).toMatch(/adulterado/);
    expect(await isRestoreHoldOn(prisma)).toBe(true); // fail-closed
  });

  it("remoção de uma linha NO MEIO do registro durável quebra a cadeia (detectada); o truncamento do FINAL não, e fica documentado como limite", async () => {
    const l = new FileLedger(ledgerPath);
    for (const c of ["m-1", "m-2", "m-3", "m-4"]) await l.done({ runId: "r", ttlSeconds: 180 * 86400, items: [{ commentId: c, event: true, records: true }] });
    const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(4);
    writeFileSync(ledgerPath, [lines[0], lines[2], lines[3]].join("\n") + "\n"); // remove a linha 2 (meio)
    expect(() => l.read()).toThrow(/adulterado|fora de ordem/);
    writeFileSync(ledgerPath, lines.slice(0, 3).join("\n") + "\n"); // remove SÓ a última
    expect(l.read()).toHaveLength(3); // LIMITE CONHECIDO: o final truncado é indistinguível de um registro mais curto sem uma âncora externa do head
  });

  it("a verificação aponta tombstones que faltam mesmo depois de reconciliar (prova que ela detecta, não só aprova)", async () => {
    const { ledger } = await scenario();
    await reconcileAndRelease(prisma, ledger);
    await prisma.idempotencyTombstone.delete({ where: { commentId: "rest-c" } });
    const v = await verifyReconciliation(prisma, ledger);
    expect(v.ok).toBe(false);
    expect(v.missingTombstones).toEqual(["rest-c"]);
  });

  it("entradas fora da janela do tombstone (já expiradas) NÃO são reaplicadas", async () => {
    await dataset();
    const longe = new FileLedger(ledgerPath, () => new Date(Date.now() - 400 * 86400_000)); // entrada de 400 dias atrás, TTL 180 d
    await longe.done({ runId: "antigo", ttlSeconds: 180 * 86400, items: [{ commentId: "rest-b", event: true, records: true }] });
    const rep = await reconcileFromLedger(prisma, new FileLedger(ledgerPath));
    expect(rep.entriesInWindow).toBe(0);
    expect(await prisma.idempotencyTombstone.count()).toBe(0);
    expect(await prisma.messageDelivery.count({ where: { commentId: "rest-b" } })).toBe(1); // dados atuais não são tocados
  });

  it("intenção sem confirmação (queda entre o registro e o commit) só ADICIONA proteção: cria o tombstone e reexclui o que existir", async () => {
    await dataset();
    const l = new FileLedger(ledgerPath);
    await l.intent({ runId: "interrompida", ttlSeconds: 180 * 86400, items: [{ commentId: "rest-c", event: false, records: true }] });
    const rep = await reconcileFromLedger(prisma, l);
    expect(rep.tombstonesRecreated).toBe(1);
    expect(await prisma.idempotencyTombstone.findUnique({ where: { commentId: "rest-c" } })).not.toBeNull();
  });

  it("o registro durável contém só IDs de comentário, flags, TTL, data e ID da execução (sem texto, autor, token nem payload)", async () => {
    await scenario();
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw).not.toMatch(/LINK|"from"|username|"text"|payload|token|EAA/i); // fromStatus/fromAttempts são estados de origem de transições, não dados de comentário
    const lines = new FileLedger(ledgerPath).read();
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(Object.keys(l).filter((k) => k !== "transitions").sort()).toEqual(["at", "hash", "items", "phase", "prev", "runId", "seq", "ttlSeconds"]);
  });

  it("cada execução registra intenção ANTES e confirmação DEPOIS, em sequência estritamente crescente e com a cadeia íntegra", async () => {
    await scenario();
    const lines = new FileLedger(ledgerPath).read();
    expect(lines.map((l) => l.phase)).toEqual(expect.arrayContaining(["intent", "done"]));
    lines.forEach((l, i) => expect(l.seq).toBe(i + 1));
    const firstIntent = lines.findIndex((l) => l.phase === "intent"), firstDone = lines.findIndex((l) => l.phase === "done" && l.items.length > 0); // as de transição não têm intenção
    expect(firstIntent).toBeLessThan(firstDone);
  });

  it("a restauração NÃO ressuscita uma HELD cancelada: a transição fica no registro durável e é reaplicada antes de liberar", async () => {
    const { ledger } = await scenario();
    const trans = ledger.read().flatMap((l) => l.transitions ?? []);
    expect(trans).toEqual([{ commentId: "rest-d", target: "dm", to: "CANCELED", fromStatus: "HELD", fromAttempts: 0 }]);
    const antes = await verifyReconciliation(prisma, ledger);
    expect(antes.unreappliedTransitions).toEqual(["rest-d"]);
    await reconcileAndRelease(prisma, ledger);
    expect((await verifyReconciliation(prisma, ledger)).unreappliedTransitions).toEqual([]);
  });

  it("a expiração do tombstone reconciliado é a ORIGINAL (data absoluta), independente do relógio de quem reconcilia", async () => {
    const { ledger } = await scenario();
    const original = new Date(new Date(ledger.read().find((l) => l.phase === "done" && l.items.length)!.at).getTime() + 180 * 86400_000);
    // reconcilia com um relógio muito deslocado: a data do tombstone não pode mudar
    await reconcileFromLedger(prisma, ledger, new Date(Date.now() + 60 * 86400_000));
    for (const c of COMMENTS) {
      const t = (await prisma.idempotencyTombstone.findUniqueOrThrow({ where: { commentId: c } })).expiresAt;
      expect(Math.abs(+t - +original)).toBeLessThan(5 * 60_000); // dentro de minutos do prazo original (as entradas diferem em ms/min entre lotes)
    }
    expect((await verifyReconciliation(prisma, ledger, new Date(Date.now() + 60 * 86400_000))).missingTombstones).toEqual([]);
  });
});
