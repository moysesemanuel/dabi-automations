import { Worker } from "bullmq";
import { createPrisma } from "@dabi/database";
import { QUEUES } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";
import { resumePending, type Deps } from "./process-comment.js";
import { handleCommentJob } from "./job-handler.js";
import { safeErrorText } from "./safe-error.js";

const env = loadEnv();
const deps: Deps = {
  prisma: createPrisma(),
  env: { sendEnabled: env.INSTAGRAM_SEND_ENABLED === "true", resumeEnabled: env.INSTAGRAM_RESUME_PENDING_ENABLED === "true", publicReplyEnabled: env.INSTAGRAM_PUBLIC_REPLY_ENABLED === "true", graphVersion: env.META_GRAPH_VERSION, encryptionKey: env.TOKEN_ENCRYPTION_KEY },
  log: (m) => console.log(`[worker] ${m}`),
};

// Retenção dos registros de job no Redis (valem para jobs NOVOS; os já existentes não são tocados aqui).
// A remoção por `age` do BullMQ é preguiçosa (só ocorre quando outro job termina), então a garantia de prazo vem
// de os jobs não carregarem dado pessoal; a limpeza agendada fica para a E3.
const worker = new Worker(QUEUES.COMMENT_EVENTS, (job) => handleCommentJob(deps, job.data), {
  connection: { url: env.REDIS_URL },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
});
// Só classe e código: nunca a mensagem original (pode conter dados do comentário).
worker.on("failed", (job, err) => console.error(`[worker] job ${job?.id ?? "?"} falhou: ${safeErrorText(err)}`));
worker.on("error", (err) => console.error(`[worker] erro do worker: ${safeErrorText(err)}`));
console.log(`worker ouvindo ${QUEUES.COMMENT_EVENTS} | envio real: ${deps.env.sendEnabled ? "LIGADO" : "desligado"} | resposta pública: ${deps.env.publicReplyEnabled ? "LIGADA" : "desligada"} | retomada de pendentes: ${deps.env.resumeEnabled ? "LIGADA" : "desligada"}`);

// Retomada de entregas PENDING: exige as DUAS flags (envio e retomada). Nunca é implícita.
if (deps.env.sendEnabled && deps.env.resumeEnabled) {
  resumePending(deps).catch((e) => console.error(`[worker] retomada abortada: ${safeErrorText(e)}`));
}
