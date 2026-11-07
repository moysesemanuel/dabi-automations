import { Worker } from "bullmq";
import { createPrisma } from "@dabi/database";
import { QUEUES } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";
import { processCommentEvent, resumePending, type Deps } from "./process-comment.js";

const env = loadEnv();
const deps: Deps = {
  prisma: createPrisma(),
  env: { sendEnabled: env.INSTAGRAM_SEND_ENABLED === "true", graphVersion: env.META_GRAPH_VERSION, encryptionKey: env.TOKEN_ENCRYPTION_KEY },
  log: (m) => console.log(`[worker] ${m}`),
};

new Worker(QUEUES.COMMENT_EVENTS, (job) => processCommentEvent(deps, job.data), { connection: { url: env.REDIS_URL } });
console.log(`worker ouvindo ${QUEUES.COMMENT_EVENTS} | envio real: ${deps.env.sendEnabled ? "LIGADO" : "desligado"}`);

// Retomada de entregas PENDING: só quando o envio estiver habilitado.
if (deps.env.sendEnabled) resumePending(deps).then((n) => n && console.log(`[worker] retomadas ${n} entregas pendentes`));
