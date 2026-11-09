// Limpeza explícita de jobs do BullMQ em Redis DESCARTÁVEL e ISOLADO (fila test-*, prefixo bull-test-*, banco lógico ≠ 0 fora do CI).
// Nunca toca a fila de desenvolvimento nem usa FLUSHALL/FLUSHDB; limpa só as próprias chaves pelo prefixo.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { REDIS_URL, REQUIRED, assertIsolatedRedis, missingInfra } from "../test-infra";
import { QUEUE_CLEAN_LIMITS, cleanQueue, validateQueueClean } from "./queue-clean";

const missing = missingInfra({ redis: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (limpeza de fila)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}`); }); });

const run = `qc${Date.now()}`;
const PREFIX = `bull-test-${run}`;
const DAY = 86_400_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(Boolean(missing))("limpeza explícita de jobs (Redis descartável)", () => {
  const connection = { url: REDIS_URL! };
  let redis: Redis; const queues: Queue[] = []; const workers: Worker[] = []; let seq = 0;
  const mkQueue = async (suffix = "") => { const name = `test-${run}-${++seq}${suffix}`; assertIsolatedRedis(REDIS_URL!, name, PREFIX); const q = new Queue(name, { connection, prefix: PREFIX }); queues.push(q); return q; };
  const key = (q: Queue, rest: string) => `${PREFIX}:${q.name}:${rest}`;
  /** Conclui N jobs de verdade e os envelhece (finishedOn). `fail`: jobs com falha. */
  const finished = async (q: Queue, ids: string[], opts: { fail?: boolean; ageMs: number }) => {
    const w = new Worker(q.name, async (j) => { if (j.data.fail) throw new Error("falha de teste"); return { outcome: "processed" }; }, { connection, prefix: PREFIX }); w.on("error", () => {}); workers.push(w);
    for (const id of ids) await q.add("t", { fail: Boolean(opts.fail) }, { jobId: id, attempts: 1 });
    for (let i = 0; i < 100; i++) { const s = await Promise.all(ids.map(async (id) => (await q.getJob(id))?.getState())); if (s.every((x) => x === (opts.fail ? "failed" : "completed"))) break; await sleep(50); }
    await w.close();
    const t = String(Date.now() - opts.ageMs); const set = opts.fail ? "failed" : "completed";
    for (const id of ids) { await redis.hset(key(q, id), "finishedOn", t); await redis.zadd(key(q, set), t, id); }
  };
  const ids = (n: number, p: string) => Array.from({ length: n }, (_, i) => `${p}${i}`);

  beforeAll(() => { redis = new Redis(REDIS_URL!); });
  afterEach(async () => { for (const w of workers.splice(0)) await w.close(true).catch(() => {}); });
  afterAll(async () => {
    for (const q of queues) await q.obliterate({ force: true }).catch(() => {});
    let cursor = "0"; do { const [n, k] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 200); cursor = n; if (k.length) await redis.del(...k); } while (cursor !== "0");
    for (const q of queues) await q.close(); await redis.quit();
  });

  it("remove SÓ os concluídos mais antigos que o prazo (por finishedOn); os recentes permanecem", async () => {
    const q = await mkQueue();
    await finished(q, ids(3, "velho"), { ageMs: 5 * DAY }); await finished(q, ids(2, "novo"), { ageMs: 1000 });
    const r = await cleanQueue(q, { expectedQueueName: q.name, graceMs: 24 * 3600_000, limit: 50 });
    expect(r.removed.completed.sort()).toEqual(ids(3, "velho"));
    expect((await q.getJobs(["completed"])).map((j) => j.id).sort()).toEqual(ids(2, "novo"));
  });

  it("respeita o LIMITE: com 10 elegíveis e limite 3, remove os 3 mais antigos", async () => {
    const q = await mkQueue();
    await finished(q, ids(10, "j"), { ageMs: 5 * DAY });
    // escalona as idades para a ordem ser determinística: j0 é o mais antigo
    for (let i = 0; i < 10; i++) { const t = String(Date.now() - (20 - i) * DAY); await redis.hset(key(q, `j${i}`), "finishedOn", t); await redis.zadd(key(q, "completed"), t, `j${i}`); }
    const r = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 3, types: ["completed"] });
    expect(r.removed.completed.sort()).toEqual(["j0", "j1", "j2"]);
    expect((await q.getJobs(["completed"])).length).toBe(7);
  });

  it("DRY-RUN lista exatamente o que a execução removeria e NÃO remove nada", async () => {
    const q = await mkQueue();
    await finished(q, ids(4, "d"), { ageMs: 5 * DAY });
    const dry = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 3, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.removed).toEqual({ completed: [], failed: [] });
    expect((await q.getJobs(["completed"])).length).toBe(4); // nada removido
    const real = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 3 });
    expect(real.removed.completed.sort()).toEqual([...dry.eligible.completed].sort());
  });

  it("NUNCA toca wait, active, delayed nem prioritized, mesmo com timestamps antigos; os contadores ficam idênticos", async () => {
    const q = await mkQueue();
    await finished(q, ids(2, "c"), { ageMs: 5 * DAY });
    await q.add("t", {}, { jobId: "aguardando", delay: 0 }); await q.pause();
    await q.add("t", {}, { jobId: "atrasado", delay: 3_600_000 * 10 });
    await redis.hset(key(q, "aguardando"), "timestamp", String(Date.now() - 30 * DAY)); await redis.hset(key(q, "atrasado"), "timestamp", String(Date.now() - 30 * DAY));
    const r = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 100 });
    expect(r.removed.completed).toHaveLength(2);
    expect(r.untouchedAfter).toEqual(r.untouchedBefore);
    expect(await q.getJob("aguardando")).toBeTruthy(); expect(await q.getJob("atrasado")).toBeTruthy();
  });

  it("jobs COM FALHA só saem quando o tipo é pedido; concluídos e falhos respeitam o mesmo limite total", async () => {
    const q = await mkQueue();
    await finished(q, ids(2, "ok"), { ageMs: 5 * DAY }); await finished(q, ids(2, "ruim"), { ageMs: 5 * DAY, fail: true });
    const soCompletos = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 100, types: ["completed"] });
    expect(soCompletos.removed.completed).toHaveLength(2); expect(soCompletos.removed.failed).toEqual([]);
    expect((await q.getJobs(["failed"])).length).toBe(2); // falhos intactos
    const ambos = await cleanQueue(q, { expectedQueueName: q.name, graceMs: DAY, limit: 1 });
    expect(ambos.removed.failed).toHaveLength(1); // limite total de 1
  });

  it("não toca em OUTRA fila do mesmo prefixo", async () => {
    const a = await mkQueue("-a"), b = await mkQueue("-b");
    await finished(a, ids(2, "a"), { ageMs: 5 * DAY }); await finished(b, ids(2, "b"), { ageMs: 5 * DAY });
    await cleanQueue(a, { expectedQueueName: a.name, graceMs: DAY, limit: 100 });
    expect((await a.getJobs(["completed"])).length).toBe(0);
    expect((await b.getJobs(["completed"])).length).toBe(2);
  });

  it("travas de segurança: fila errada, fila real sem autorização, prazo curto, limite inválido e tipos proibidos são RECUSADOS sem tocar em nada", async () => {
    const q = await mkQueue();
    await finished(q, ids(2, "t"), { ageMs: 5 * DAY });
    const base = { expectedQueueName: q.name, graceMs: DAY, limit: 10 };
    await expect(cleanQueue(q, { ...base, expectedQueueName: "outra-fila" })).rejects.toThrow(/não é a esperada/);
    await expect(cleanQueue(q, { ...base, graceMs: 1000 })).rejects.toThrow(/prazo mínimo/);
    for (const limit of [0, -1, 101, 1.5, NaN]) await expect(cleanQueue(q, { ...base, limit })).rejects.toThrow(/limite/);
    await expect(cleanQueue(q, { ...base, types: ["wait" as any] })).rejects.toThrow(/tipo não permitido/);
    await expect(cleanQueue(q, { ...base, types: ["active" as any, "delayed" as any] })).rejects.toThrow(/tipo não permitido/);
    expect((await q.getJobs(["completed"])).length).toBe(2); // nada foi tocado
    // a fila REAL de desenvolvimento/produção exige autorização específica (e os testes nunca a usam)
    expect(validateQueueClean("comment-events", { expectedQueueName: "comment-events", graceMs: DAY, limit: 10 })).toEqual(["fila real: exige autorização específica (allowRealQueue)"]);
    expect(validateQueueClean("comment-events", { expectedQueueName: "comment-events", graceMs: DAY, limit: 10, allowRealQueue: true })).toEqual([]);
    expect(QUEUE_CLEAN_LIMITS).toEqual({ maxLimit: 100, minGraceMs: 3_600_000 });
  });

  it("isolamento do ambiente: o prefixo e a fila do teste nunca são os de desenvolvimento", () => {
    expect(PREFIX.startsWith("bull-test-")).toBe(true);
    for (const q of queues) { expect(q.name.startsWith("test-")).toBe(true); expect(q.name).not.toBe("comment-events"); }
    expect(() => assertIsolatedRedis(REDIS_URL!, "comment-events", PREFIX)).toThrow();
    expect(() => assertIsolatedRedis(REDIS_URL!, `test-${run}`, "bull")).toThrow();
  });
});
