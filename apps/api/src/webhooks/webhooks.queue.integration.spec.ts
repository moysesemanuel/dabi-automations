// Lado do PRODUTOR (API) com BullMQ em Redis REAL: o que de fato vai parar no Redis. Sem worker e sem Meta.
// Isolamento: fila "test-…", prefixo "bull-test-…", banco lógico ≠ 0 fora do CI; limpeza só das chaves do prefixo.
//   TEST_REDIS_URL=redis://localhost:6390/15 pnpm --filter @dabi/api test
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { WebhooksService } from "./webhooks.service";

const REDIS_URL = process.env.TEST_REDIS_URL;
const REQUIRED = process.env.REQUIRE_INTEGRATION === "1" || process.env.CI === "true";
if (REQUIRED && !REDIS_URL) describe("infraestrutura obrigatória (E2, API)", () => { it("precisa de TEST_REDIS_URL", () => { throw new Error("falta TEST_REDIS_URL: no CI os testes de integração são obrigatórios"); }); });

const SEGREDO = "TEXTO-SECRETO-DO-COMENTARISTA";
const USER = "usuario_secreto";
const run = `p${Date.now()}`;
const QUEUE = `test-${run}`;
const PREFIX = `bull-test-${run}`;
const NOW = new Date("2026-11-09T12:00:00Z");

describe.skipIf(!REDIS_URL)("API → Redis real: o que o webhook enfileira", () => {
  let queue: Queue; let redis: Redis;
  const body = (cid: string) => ({ object: "instagram", entry: [{ id: "ig1", changes: [{ field: "comments", value: { id: cid, text: SEGREDO, from: { id: "u1", username: USER }, media: { id: "m1" } } }] }] });

  const setup = (format: "legacy" | "minimal") => {
    const store: Record<string, any> = {};
    let n = 0;
    const prisma: any = {
      automationEvent: {
        findUnique: async ({ where }: any) => store[where.providerEventKey] ?? null,
        create: async ({ data }: any) => (store[data.providerEventKey] = { id: `ev${++n}${run}`, status: "RECEIVED", igAccountId: null, ...data }),
        update: async () => ({}),
      },
      socialAccount: { findUnique: async () => ({ organizationId: "o1", disconnectedAt: null, credential: { id: "c" } }) },
      idempotencyTombstone: { findUnique: async () => null },
    };
    const svc: any = new WebhooksService(prisma, { format, now: () => NOW });
    svc._queue = queue;
    return { svc: svc as WebhooksService, store };
  };
  const raw = async (id: string) => JSON.stringify(await redis.hgetall(`${PREFIX}:${QUEUE}:${id}`));

  beforeAll(async () => {
    const db = Number(new URL(REDIS_URL!).pathname.replace("/", "") || "0");
    if (!QUEUE.startsWith("test-") || !PREFIX.startsWith("bull-test-")) throw new Error("fila/prefixo de teste inválidos");
    if (!process.env.CI && db === 0) throw new Error("TEST_REDIS_URL deve usar um banco lógico diferente do 0 (ex.: redis://localhost:6390/15) fora do CI");
    queue = new Queue(QUEUE, { connection: { url: REDIS_URL! }, prefix: PREFIX });
    redis = new Redis(REDIS_URL!);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => {});
    let cursor = "0";
    do { const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 200); cursor = next; if (keys.length) await redis.del(...keys); } while (cursor !== "0");
    await redis.quit();
    await queue.close();
  });

  it("minimal: o hash inteiro do job no Redis não contém texto, autor, ids da Meta nem payload", async () => {
    const { svc, store } = setup("minimal");
    await svc.ingest(body("c-min"));
    const ev = store["comment:c-min"];
    const job = (await queue.getJob(`evt-${ev.id}`))!;
    expect(job.data).toEqual({ eventId: ev.id });
    expect(job.opts).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 2000 }, removeOnComplete: { age: 86400, count: 1000 }, removeOnFail: { age: 604800, count: 5000 } });
    const r = await raw(`evt-${ev.id}`);
    for (const proibido of [SEGREDO, USER, "c-min", "m1", "ig1", "u1", "payload"]) expect(r).not.toContain(proibido);
  });

  it("legacy (padrão): continua com o job completo de antes (comportamento inalterado) e o mesmo jobId", async () => {
    const { svc, store } = setup("legacy");
    await svc.ingest(body("c-leg"));
    const ev = store["comment:c-leg"];
    const job = (await queue.getJob("comment-c-leg"))!;
    expect(job.data).toEqual({ eventId: ev.id, igAccountId: "ig1", commentId: "c-leg", mediaId: "m1", text: SEGREDO, fromId: "u1" });
  });

  it("webhook reentregue: o mesmo evento não cria um segundo job (jobId estável)", async () => {
    const { svc, store } = setup("minimal");
    await svc.ingest(body("c-dup")); await svc.ingest(body("c-dup")); await svc.ingest(body("c-dup"));
    const ev = store["comment:c-dup"];
    const waiting = (await queue.getJobs(["waiting", "delayed", "active"])).filter((j) => j.id === `evt-${ev.id}`);
    expect(waiting).toHaveLength(1);
  });
});
