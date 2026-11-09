// Fixture de teste (NÃO é código de produção): worker real (handleCommentJob) cuja chamada à Meta NUNCA responde.
// O teste a encerra com SIGKILL para simular a morte do processo no meio da chamada. Só roda com fila/prefixo de teste.
import { PrismaClient } from "@prisma/client";
import { Worker } from "bullmq";
import { handleCommentJob } from "../job-handler";
import { assertIsolatedRedis } from "../test-infra";

const { TEST_DATABASE_URL, TEST_REDIS_URL, FIXTURE_QUEUE, FIXTURE_PREFIX, FIXTURE_KEY } = process.env as Record<string, string>;
assertIsolatedRedis(TEST_REDIS_URL, FIXTURE_QUEUE, FIXTURE_PREFIX);
const NOW = new Date("2026-11-09T12:00:00Z");

const deps: any = {
  prisma: new PrismaClient({ datasourceUrl: TEST_DATABASE_URL }),
  now: () => NOW,
  env: { sendEnabled: true, resumeEnabled: false, publicReplyEnabled: false, graphVersion: "v23.0", encryptionKey: FIXTURE_KEY },
  fetchImpl: (async (u: any) => {
    if (String(u).includes("/messages")) { console.log("META_CALL_STARTED"); await new Promise(() => {}); }
    return new Response(JSON.stringify({ timestamp: new Date(NOW.getTime() - 3600_000).toISOString().replace("Z", "+0000") }), { status: 200 });
  }) as any,
};
new Worker(FIXTURE_QUEUE, (job) => handleCommentJob(deps, job.data), { connection: { url: TEST_REDIS_URL }, prefix: FIXTURE_PREFIX, lockDuration: 1000, stalledInterval: 500, maxStalledCount: 3 });
console.log("FIXTURE_READY");
