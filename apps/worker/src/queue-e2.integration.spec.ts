// E2: jobs mínimos e idempotência com BullMQ (Redis REAL) e PostgreSQL REAL. A Meta é SEMPRE um mock: nenhum teste
// envia mensagem de verdade. Isolamento do Redis: ver test-infra.ts.
//   TEST_DATABASE_URL=postgresql://dabi:dabi@localhost:5440/dabi_test TEST_REDIS_URL=redis://localhost:6390/15 pnpm --filter @dabi/worker test
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { encryptToken } from "@dabi/config";
import { handleCommentJob } from "./job-handler";
import type { Deps } from "./process-comment";
import { PG_URL, REDIS_URL, REQUIRED, assertIsolatedRedis, missingInfra } from "./test-infra";

// Opções de job iguais às que a API usa (apps/api/src/webhooks/webhooks.service.ts: JOB_OPTIONS).
const JOB_OPTIONS = { attempts: 3, backoff: { type: "exponential" as const, delay: 2000 }, removeOnComplete: { age: 24 * 3600, count: 1000 }, removeOnFail: { age: 7 * 24 * 3600, count: 5000 } };

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const missing = missingInfra({ pg: true, redis: true });
if (REQUIRED && missing) describe("infraestrutura obrigatória (E2)", () => { it(`precisa de ${missing}`, () => { throw new Error(`faltam ${missing}: no CI os testes de integração são obrigatórios`); }); });

const SEGREDO = "TEXTO-SECRETO-DO-COMENTARISTA";
const USER = "usuario_secreto";
const KEY = Buffer.alloc(32, 7).toString("base64");
const NOW = new Date("2026-11-09T12:00:00Z");
const run = `q${Date.now()}`;
const QUEUE = `test-${run}`;
const PREFIX = `bull-test-${run}`;

describe.skipIf(Boolean(missing))("E2: jobs mínimos e idempotência (PostgreSQL + Redis reais, Meta simulada)", () => {
  const prisma = new PrismaClient({ datasourceUrl: PG_URL });
  const connection = { url: REDIS_URL! };
  let queue: Queue;
  let redis: Redis; // cliente só para inspecionar/limpar as chaves DESTE teste (prefixo exclusivo)
  const workers: Worker[] = [];
  let orgId = "", accId = "", orgId2 = "", accId2 = "";
  const eventIds: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond: () => Promise<boolean>, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await cond()) return; await sleep(25); } throw new Error("timeout esperando condição"); };

  /** Meta simulada: conta as chamadas de envio; `mode` controla o comportamento. */
  const mkMeta = () => {
    const calls = { messages: 0, replies: 0 };
    const state: { mode: "ok" | "network" | "hang" } = { mode: "ok" };
    const fetchImpl = (async (u: any) => {
      const url = String(u);
      if (url.includes("/messages")) {
        calls.messages++;
        if (state.mode === "network") throw new Error("network down");
        if (state.mode === "hang") await new Promise(() => {}); // nunca responde: simula queda do processo no meio da chamada
        return new Response(JSON.stringify({ recipient_id: "r", message_id: "m" }), { status: 200 });
      }
      if (url.includes("/replies")) { calls.replies++; return new Response(JSON.stringify({ id: "reply" }), { status: 200 }); }
      return new Response(JSON.stringify({ timestamp: new Date(NOW.getTime() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 });
    }) as any;
    return { calls, state, fetchImpl };
  };

  type Fault = { model: string; op: string; times: number; when?: (args: any) => boolean; error: () => Error };
  /** Envolve o Prisma para falhar em pontos escolhidos (simula banco indisponível). */
  const withFaults = (real: PrismaClient, faults: Fault[]) =>
    new Proxy(real as any, {
      get(t, model: string) {
        const delegate = t[model];
        if (typeof delegate !== "object" || delegate === null) return typeof delegate === "function" ? delegate.bind(t) : delegate;
        return new Proxy(delegate, {
          get(d, op: string) {
            const fn = d[op];
            if (typeof fn !== "function") return fn;
            return (...args: any[]) => {
              const f = faults.find((x) => x.model === model && x.op === op && x.times > 0 && (!x.when || x.when(args[0])));
              if (f) { f.times--; throw f.error(); }
              return fn.apply(d, args);
            };
          },
        });
      },
    }) as PrismaClient;
  const dbDown = () => Object.assign(new Error(`Can't reach database server ${SEGREDO}`), { name: "PrismaClientInitializationError", code: "P1001" });

  const mkDeps = (meta: ReturnType<typeof mkMeta>, p: any = prisma, logs: string[] = []): Deps => ({
    prisma: p, now: () => NOW, log: (m) => logs.push(m),
    env: { sendEnabled: true, resumeEnabled: false, publicReplyEnabled: false, graphVersion: "v23.0", encryptionKey: KEY },
    fetchImpl: meta.fetchImpl,
  });

  const startWorker = (deps: Deps, o: Record<string, unknown> = {}) => {
    const w = new Worker(QUEUE, (job: Job) => handleCommentJob(deps, job.data), {
      connection, prefix: PREFIX, concurrency: 4,
      // O BullMQ compartilha a chave "stalled-check" entre workers, com validade = stalledInterval de quem a gravou por último.
      // Intervalo curto em TODOS os workers de teste evita que um worker anterior (padrão 30 s) atrase a detecção de jobs travados.
      lockDuration: 1000, stalledInterval: 500, maxStalledCount: 3,
      ...o,
    });
    w.on("error", () => {});
    workers.push(w);
    return w;
  };

  const mkEvent = async (cid: string, over: Record<string, unknown> = {}) => {
    const ev = await prisma.automationEvent.create({
      data: { providerEventKey: `comment:${cid}`, igAccountId: `${run}-ig`, payload: { field: "comments", value: { id: cid, text: `LINK ${SEGREDO}`, from: { id: "u1", username: USER }, media: { id: `${run}-m` } } }, ...over },
    });
    eventIds.push(ev.id);
    return ev;
  };
  const legacyJob = (ev: { id: string }, cid: string) => ({ eventId: ev.id, igAccountId: `${run}-ig`, commentId: cid, mediaId: `${run}-m`, text: `LINK ${SEGREDO}`, fromId: "u1" });
  const stateOf = async (id: string) => (await queue.getJob(id))?.getState();
  const rawJob = async (id: string) => JSON.stringify(await redis.hgetall(`${PREFIX}:${QUEUE}:${id}`));
  const deliveries = (cid: string) => prisma.messageDelivery.findMany({ where: { commentId: cid } });

  beforeAll(async () => {
    assertIsolatedRedis(REDIS_URL!, QUEUE, PREFIX);
    queue = new Queue(QUEUE, { connection, prefix: PREFIX });
    redis = new Redis(REDIS_URL!);
    const enc = encryptToken("EAAPRtesttoken", KEY);
    const mk = async (suffix: string) => {
      const org = await prisma.organization.create({ data: { name: `test ${run}${suffix}` } });
      const acc = await prisma.socialAccount.create({ data: { organizationId: org.id, providerAccountId: `${run}-ig${suffix}`, username: "t", credential: { create: { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK" } } } });
      const media = await prisma.media.create({ data: { organizationId: org.id, socialAccountId: acc.id, providerMediaId: `${run}-m${suffix}` } });
      await prisma.automation.create({ data: { organizationId: org.id, socialAccountId: acc.id, mediaId: media.id, keyword: "LINK", replyMessage: "Oi", status: "ACTIVE" } });
      return { orgId: org.id, accId: acc.id };
    };
    ({ orgId, accId } = await mk(""));
    ({ orgId: orgId2, accId: accId2 } = await mk("-b"));
  });

  // Cada teste começa sem nenhum worker de testes anteriores consumindo a fila com outro mock da Meta.
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => {})));
  });

  afterAll(async () => {
    for (const w of workers) await w.close(true).catch(() => {});
    // limpeza SÓ das chaves deste teste (prefixo exclusivo); nunca FLUSH
    await queue.obliterate({ force: true }).catch(() => {});
    let cursor = "0";
    do { const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 200); cursor = next; if (keys.length) await redis.del(...keys); } while (cursor !== "0");
    await redis.quit();
    await queue.close();
    await prisma.automationEvent.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.organization.deleteMany({ where: { id: { in: [orgId, orgId2].filter(Boolean) } } });
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────────── formato do job e do resultado ───────────────────────────────────────────
  describe("job mínimo: nenhum dado pessoal no Redis", () => {
    it("job mínimo → fila real → worker: data = { eventId }, returnvalue = { outcome }, e NADA do comentário no hash inteiro do job", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-pii1`; const ev = await mkEvent(cid);
      const id = `evt-${ev.id}`;
      await queue.add("comment", { eventId: ev.id }, { jobId: id, ...JOB_OPTIONS });
      await until(async () => (await stateOf(id)) === "completed");
      const job = (await queue.getJob(id))!;
      expect(job.data).toEqual({ eventId: ev.id });
      expect(job.returnvalue).toEqual({ outcome: "processed" });
      const raw = await rawJob(id);
      for (const proibido of [SEGREDO, USER, cid, `${run}-m`, "payload"]) expect(raw).not.toContain(proibido);
      expect((await deliveries(cid))[0]).toMatchObject({ status: "SENT", attempts: 1 });
      expect(meta.calls.messages).toBe(1);
    });

    it("jobs legados, por contraste, carregam o texto (é o que a E2 evita) — mas o returnvalue deles também fica mínimo", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-leg1`; const ev = await mkEvent(cid);
      const j = await queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(j.id!)) === "completed");
      const raw = await rawJob(j.id!);
      expect(raw).toContain(SEGREDO); // dado de ENTRADA do job legado (inalterado nesta etapa)
      const rv = JSON.stringify((await queue.getJob(j.id!))!.returnvalue);
      expect(rv).toBe('{"outcome":"processed"}');
      expect(rv).not.toMatch(new RegExp(`${SEGREDO}|${USER}|payload`));
    });
  });

  // ─────────────────────────────────────────── idempotência e concorrência ───────────────────────────────────────────
  describe("sem envio duplicado", () => {
    it("job legado + job mínimo para o MESMO comentário, em dois workers: exatamente 1 envio", async () => {
      const meta = mkMeta(); const d = mkDeps(meta); startWorker(d); startWorker(d);
      const cid = `${run}-mix1`; const ev = await mkEvent(cid);
      await Promise.all([
        queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}`, ...JOB_OPTIONS }),
        queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, ...JOB_OPTIONS }),
        queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}-redelivery`, ...JOB_OPTIONS }),
        queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}-redelivery`, ...JOB_OPTIONS }),
      ]);
      await until(async () => (await Promise.all([`comment-${cid}`, `evt-${ev.id}`, `comment-${cid}-redelivery`, `evt-${ev.id}-redelivery`].map(stateOf))).every((s) => s === "completed"));
      expect(meta.calls.messages).toBe(1);
      const ds = await deliveries(cid);
      expect(ds).toHaveLength(1);
      expect(ds[0]).toMatchObject({ status: "SENT", attempts: 1 });
    });

    it("dois comentários DIFERENTES ao mesmo tempo, dois workers: um envio para cada, sem interferência", async () => {
      const meta = mkMeta(); const d = mkDeps(meta); startWorker(d); startWorker(d);
      const ca = `${run}-par-a`, cb = `${run}-par-b`;
      const ea = await mkEvent(ca), eb = await mkEvent(cb);
      await Promise.all([queue.add("comment", { eventId: ea.id }, { jobId: `evt-${ea.id}` }), queue.add("comment", { eventId: eb.id }, { jobId: `evt-${eb.id}` })]);
      await until(async () => (await stateOf(`evt-${ea.id}`)) === "completed" && (await stateOf(`evt-${eb.id}`)) === "completed");
      expect(meta.calls.messages).toBe(2);
      expect((await deliveries(ca))).toHaveLength(1);
      expect((await deliveries(cb))).toHaveLength(1);
    });

    it("mesmo evento com 8 execuções simultâneas direto no handler (sem fila): 1 envio", async () => {
      const meta = mkMeta(); const d = mkDeps(meta);
      const cid = `${run}-direct`; const ev = await mkEvent(cid);
      await Promise.all(Array.from({ length: 8 }, (_, i) => handleCommentJob(d, i % 2 ? { eventId: ev.id } : legacyJob(ev, cid))));
      expect(meta.calls.messages).toBe(1);
      expect(await deliveries(cid)).toHaveLength(1);
    });
  });

  describe("banco indisponível ANTES do claim", () => {
    it("a primeira tentativa falha sem chamar a Meta; o BullMQ repete e a segunda envia UMA vez", async () => {
      const meta = mkMeta(); const logs: string[] = [];
      const faulty = withFaults(prisma, [{ model: "automationEvent", op: "findUnique", times: 1, error: dbDown }]);
      startWorker(mkDeps(meta, faulty, logs));
      const cid = `${run}-down1`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, attempts: 3, backoff: { type: "fixed", delay: 50 } });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      const job = (await queue.getJob(`evt-${ev.id}`))!;
      expect(job.attemptsMade).toBe(2); // 1 falha + 1 sucesso
      expect(meta.calls.messages).toBe(1);
      expect((await deliveries(cid))[0]).toMatchObject({ status: "SENT", attempts: 1 });
      expect(logs.join("\n")).not.toContain(SEGREDO);
    });

    it("banco fora durante todas as tentativas: o job falha, NADA foi enviado, o evento segue RECEIVED e o motivo registrado é normalizado", async () => {
      const meta = mkMeta();
      const faulty = withFaults(prisma, [{ model: "automationEvent", op: "findUnique", times: 99, error: dbDown }]);
      startWorker(mkDeps(meta, faulty));
      const cid = `${run}-down2`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, attempts: 2, backoff: { type: "fixed", delay: 50 } });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "failed");
      expect(meta.calls.messages).toBe(0);
      expect(await deliveries(cid)).toHaveLength(0);
      expect((await prisma.automationEvent.findUniqueOrThrow({ where: { id: ev.id } })).status).toBe("RECEIVED");
      const job = (await queue.getJob(`evt-${ev.id}`))!;
      expect(job.failedReason).toBe("transient:PrismaClientInitializationError:P1001");
      const raw = await rawJob(`evt-${ev.id}`);
      expect(raw).not.toContain(SEGREDO);
      expect(JSON.stringify(job.stacktrace)).not.toContain(SEGREDO);
    });
  });

  describe("Meta respondeu sucesso e o banco falhou ANTES de gravar SENT", () => {
    it("a repetição NÃO chama a Meta de novo: a entrega termina UNKNOWN (conservador) e só houve 1 chamada", async () => {
      const meta = mkMeta();
      const faulty = withFaults(prisma, [{ model: "messageDelivery", op: "update", times: 1, when: (a) => a?.data?.status === "SENT", error: dbDown }]);
      startWorker(mkDeps(meta, faulty));
      const cid = `${run}-post1`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, attempts: 3, backoff: { type: "fixed", delay: 50 } });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      expect(meta.calls.messages).toBe(1); // sucesso na Meta uma única vez
      const [d] = await deliveries(cid);
      expect(d.status).toBe("UNKNOWN"); // não sabemos se o SENT foi registrado: nunca reenviar às cegas
      expect(d.attempts).toBe(1);
      expect(d.error ?? "").toMatch(/interrompido|incert|não reenviar/i);
    });

    it("o mesmo vale se o webhook for reentregue depois (novo job para o mesmo comentário): nenhuma chamada extra", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-post1`; // reaproveita o comentário do teste anterior
      const ev = await prisma.automationEvent.findUniqueOrThrow({ where: { providerEventKey: `comment:${cid}` } });
      await queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}-late`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`comment-${cid}-late`)) === "completed");
      expect(meta.calls.messages).toBe(0);
      expect((await deliveries(cid))[0].status).toBe("UNKNOWN");
    });
  });

  describe("reinício do worker após resultado ambíguo", () => {
    it("Meta deu erro de rede (resultado ambíguo → UNKNOWN); worker reiniciado e job reentregue: nenhuma chamada nova", async () => {
      const meta = mkMeta(); meta.state.mode = "network";
      const w1 = startWorker(mkDeps(meta));
      const cid = `${run}-restart1`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      expect((await deliveries(cid))[0].status).toBe("UNKNOWN");
      expect(meta.calls.messages).toBe(1);
      await w1.close(); // "reinício"
      meta.state.mode = "ok"; // a Meta voltou; mesmo assim NÃO se reenvia
      startWorker(mkDeps(meta));
      await queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}-after-restart`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`comment-${cid}-after-restart`)) === "completed");
      expect(meta.calls.messages).toBe(1);
      expect((await deliveries(cid))[0].status).toBe("UNKNOWN");
    });

    it("processo morre NO MEIO da chamada à Meta (SIGKILL de um processo real): outro worker assume e NÃO reenvia; termina UNKNOWN", async () => {
      // O worker "morto" roda em um processo filho (código real de produção; só a chamada à Meta nunca responde).
      const child = spawn(process.execPath, ["--import", "tsx", "src/test-fixtures/hanging-worker.ts"], {
        cwd: process.cwd(), // o vitest roda na pasta do pacote (apps/worker), local e no CI
        env: { ...process.env, TEST_DATABASE_URL: PG_URL, TEST_REDIS_URL: REDIS_URL, FIXTURE_QUEUE: QUEUE, FIXTURE_PREFIX: PREFIX, FIXTURE_KEY: KEY },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout.on("data", (d) => (out += String(d)));
      child.stderr.on("data", (d) => (err += String(d)));
      try {
        await until(async () => out.includes("FIXTURE_READY"), 20000).catch((e) => { throw new Error(`${e.message}; stderr do filho: ${err.slice(0, 400)}`); });
        const cid = `${run}-kill1`; const ev = await mkEvent(cid);
        await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, attempts: 3, backoff: { type: "fixed", delay: 50 } });
        await until(async () => out.includes("META_CALL_STARTED"), 20000); // claim feito e chamada em curso
        expect((await deliveries(cid))[0]).toMatchObject({ status: "PENDING", attempts: 1 });
        expect(await stateOf(`evt-${ev.id}`)).toBe("active");
        child.kill("SIGKILL"); // morte real: sem concluir, sem liberar o lock, sem renovar nada
        await sleep(200);
        const meta = mkMeta(); // a Meta "voltou": se alguém chamar de novo, será contado
        startWorker(mkDeps(meta), { lockDuration: 1000, stalledInterval: 500, maxStalledCount: 3 });
        await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed", 25000);
        expect(meta.calls.messages).toBe(0); // a retomada NÃO chamou a Meta
        expect((await deliveries(cid))[0]).toMatchObject({ status: "UNKNOWN", attempts: 1 });
        expect(await deliveries(cid)).toHaveLength(1);
      } finally {
        child.kill("SIGKILL");
      }
    }, 60000);

    it("estado deixado por um processo que morreu entre o claim e a chamada (PENDING, attempts 1): reinício não envia", async () => {
      const meta = mkMeta(); const d = mkDeps(meta);
      const cid = `${run}-kill2`; const ev = await mkEvent(cid);
      const auto = await prisma.automation.findFirstOrThrow({ where: { organizationId: orgId } });
      await prisma.messageDelivery.create({ data: { organizationId: orgId, automationId: auto.id, commentId: cid, status: "PENDING", attempts: 1 } });
      await handleCommentJob(d, { eventId: ev.id });
      expect(meta.calls.messages).toBe(0);
      expect((await deliveries(cid))[0].status).toBe("UNKNOWN");
    });
  });

  describe("evento ausente e associação inconsistente", () => {
    it("evento inexistente: o job conclui como dropped, sem retry e sem chamar a Meta", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const j = await queue.add("comment", { eventId: `${run}-nao-existe` }, { jobId: `evt-${run}-nao-existe`, attempts: 3, backoff: { type: "fixed", delay: 50 } });
      await until(async () => (await stateOf(j.id!)) === "completed");
      const job = (await queue.getJob(j.id!))!;
      expect(job.returnvalue).toEqual({ outcome: "dropped" });
      expect(job.attemptsMade).toBe(1);
      expect(meta.calls.messages).toBe(0);
    });

    it("evento apagado ENTRE o enfileiramento e a execução: dropped", async () => {
      const meta = mkMeta();
      const cid = `${run}-gone`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, delay: 400 });
      await prisma.automationEvent.delete({ where: { id: ev.id } });
      startWorker(mkDeps(meta));
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      expect((await queue.getJob(`evt-${ev.id}`))!.returnvalue).toEqual({ outcome: "dropped" });
      expect(meta.calls.messages).toBe(0);
    });

    it("igAccountId ausente: needs_review, nada enviado, evento continua RECEIVED", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-noacc`; const ev = await mkEvent(cid, { igAccountId: null });
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      expect((await queue.getJob(`evt-${ev.id}`))!.returnvalue).toEqual({ outcome: "needs_review" });
      expect(meta.calls.messages).toBe(0);
      expect(await deliveries(cid)).toHaveLength(0);
      const after = await prisma.automationEvent.findUniqueOrThrow({ where: { id: ev.id } });
      expect(after.status).toBe("RECEIVED");
      expect(after.error).toBe("needs_review.ig_account_missing");
    });

    it("associação inconsistente (evento já ligado à conta/organização B, igAccountId da conta A): needs_review, nada enviado", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-incons`; const ev = await mkEvent(cid, { socialAccountId: accId2, organizationId: orgId2 });
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed");
      expect((await queue.getJob(`evt-${ev.id}`))!.returnvalue).toEqual({ outcome: "needs_review" });
      expect(meta.calls.messages).toBe(0);
      expect(await deliveries(cid)).toHaveLength(0);
    });

    it("tombstone: comentário protegido não é processado, nem pelo job legado nem pelo mínimo", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const cid = `${run}-tomb`; const ev = await mkEvent(cid);
      await prisma.idempotencyTombstone.create({ data: { commentId: cid, expiresAt: new Date(NOW.getTime() + 86_400_000) } });
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, ...JOB_OPTIONS });
      await queue.add("comment", legacyJob(ev, cid), { jobId: `comment-${cid}`, ...JOB_OPTIONS });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "completed" && (await stateOf(`comment-${cid}`)) === "completed");
      expect(meta.calls.messages).toBe(0);
      expect(await deliveries(cid)).toHaveLength(0);
      await prisma.idempotencyTombstone.delete({ where: { commentId: cid } });
    });
  });

  describe("erros e retenção no BullMQ", () => {
    it("erro inesperado com dado do comentário na mensagem: failedReason, stacktrace e o hash inteiro do job saem sem esse dado", async () => {
      const meta = mkMeta();
      const boom = Object.assign(new Error(`Invalid invocation: data: { text: "${SEGREDO}", user: "${USER}" }`), { name: "PrismaClientValidationError" });
      const faulty = withFaults(prisma, [{ model: "socialAccount", op: "findUnique", times: 99, error: () => boom }]);
      startWorker(mkDeps(meta, faulty));
      const cid = `${run}-boom`; const ev = await mkEvent(cid);
      await queue.add("comment", { eventId: ev.id }, { jobId: `evt-${ev.id}`, attempts: 1 });
      await until(async () => (await stateOf(`evt-${ev.id}`)) === "failed");
      const job = (await queue.getJob(`evt-${ev.id}`))!;
      expect(job.failedReason).toBe("error:PrismaClientValidationError");
      const raw = await rawJob(`evt-${ev.id}`);
      expect(raw).not.toContain(SEGREDO);
      expect(raw).not.toContain(USER);
      expect(meta.calls.messages).toBe(0);
    });

    it("job com formato inválido: falha SEM repetir (UnrecoverableError) e sem o conteúdo no Redis", async () => {
      const meta = mkMeta(); startWorker(mkDeps(meta));
      const j = await queue.add("comment", { eventId: "x", text: SEGREDO }, { jobId: `bad-${run}`, attempts: 3, backoff: { type: "fixed", delay: 50 } });
      await until(async () => (await stateOf(j.id!)) === "failed");
      const job = (await queue.getJob(j.id!))!;
      expect(job.attemptsMade).toBe(1);
      expect(job.failedReason).toBe("job_invalid:minimal_shape_invalid");
      // o conteúdo do job de ENTRADA (que foi quem montou o job inválido) está em `data`; o que o worker escreveu não repete o conteúdo
      expect(`${job.failedReason}${JSON.stringify(job.stacktrace)}${JSON.stringify(job.returnvalue)}`).not.toContain(SEGREDO);
      expect(meta.calls.messages).toBe(0);
    });

    it("retenção do BullMQ é PREGUIÇOSA: com age curto, o job antigo continua até OUTRO job terminar (documenta o comportamento real)", async () => {
      const meta = mkMeta();
      startWorker(mkDeps(meta), { removeOnComplete: { age: 1, count: 1000 } });
      const c1 = `${run}-ret1`, c2 = `${run}-ret2`;
      const e1 = await mkEvent(c1), e2 = await mkEvent(c2);
      await queue.add("comment", { eventId: e1.id }, { jobId: `evt-${e1.id}` });
      await until(async () => (await stateOf(`evt-${e1.id}`)) === "completed");
      await sleep(2500); // bem acima do age (1 s)
      expect(await stateOf(`evt-${e1.id}`)).toBe("completed"); // não saiu sozinho: sem outro job terminando, não há remoção
      await queue.add("comment", { eventId: e2.id }, { jobId: `evt-${e2.id}` });
      await until(async () => (await stateOf(`evt-${e2.id}`)) === "completed");
      await until(async () => (await queue.getJob(`evt-${e1.id}`)) === undefined, 5000); // só agora o antigo é avaliado e removido
    });
  });
});
