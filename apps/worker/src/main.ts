import { Worker } from "bullmq";
import { createPrisma } from "@dabi/database";
import { QUEUES, commentEventJobSchema, normalizeKeyword } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";

const env = loadEnv();
const prisma = createPrisma();

new Worker(
  QUEUES.COMMENT_EVENTS,
  async (job) => {
    const data = commentEventJobSchema.parse(job.data);
    const account = await prisma.socialAccount.findUnique({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: data.igAccountId } },
    });
    if (!account) return prisma.automationEvent.update({ where: { id: data.eventId }, data: { status: "IGNORED", error: "conta desconhecida" } });

    const automations = await prisma.automation.findMany({
      where: { socialAccountId: account.id, status: "ACTIVE", media: { providerMediaId: data.mediaId } },
    });
    const text = normalizeKeyword(data.text);
    const match = automations.find((a) => text.includes(normalizeKeyword(a.keyword)));
    if (!match) return prisma.automationEvent.update({ where: { id: data.eventId }, data: { status: "IGNORED" } });

    // Reserva idempotente: unique(commentId) impede 2 envios para o mesmo comentário.
    try {
      await prisma.messageDelivery.create({
        data: { organizationId: match.organizationId, automationId: match.id, commentId: data.commentId },
      });
    } catch (e: any) {
      if (e?.code === "P2002") return; // já reservado/enviado
      throw e;
    }
    // TODO (etapa 3): chamar Private Replies na Graph API ({env.META_GRAPH_VERSION}),
    // marcando SENT/FAILED, e UNKNOWN em timeout (nunca reenviar às cegas).
    await prisma.automationEvent.update({
      where: { id: data.eventId },
      data: { status: "PROCESSED", organizationId: match.organizationId, socialAccountId: account.id },
    });
  },
  { connection: { url: env.REDIS_URL } },
);
console.log("worker ouvindo", QUEUES.COMMENT_EVENTS);
