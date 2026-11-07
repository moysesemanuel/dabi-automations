import { Worker } from "bullmq";
import { createPrisma } from "@dabi/database";
import { QUEUES } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";
import { processCommentEvent, resumePending, type Deps } from "./process-comment.js";

const env = loadEnv();
const deps: Deps = {
  prisma: createPrisma(),
  env: { sendEnabled: env.INSTAGRAM_SEND_ENABLED === "true", resumeEnabled: env.INSTAGRAM_RESUME_PENDING_ENABLED === "true", publicReplyEnabled: env.INSTAGRAM_PUBLIC_REPLY_ENABLED === "true", graphVersion: env.META_GRAPH_VERSION, encryptionKey: env.TOKEN_ENCRYPTION_KEY },
  log: (m) => console.log(`[worker] ${m}`),
};

new Worker(QUEUES.COMMENT_EVENTS, (job) => processCommentEvent(deps, job.data), { connection: { url: env.REDIS_URL } });
console.log(`worker ouvindo ${QUEUES.COMMENT_EVENTS} | envio real: ${deps.env.sendEnabled ? "LIGADO" : "desligado"} | resposta pública: ${deps.env.publicReplyEnabled ? "LIGADA" : "desligada"} | retomada de pendentes: ${deps.env.resumeEnabled ? "LIGADA" : "desligada"}`);

// Retomada de entregas PENDING: exige as DUAS flags (envio e retomada). Nunca é implícita.
if (deps.env.sendEnabled && deps.env.resumeEnabled) {
  resumePending(deps).catch((e) => console.error("[worker] retomada abortada:", e instanceof Error ? e.message : e));
}
