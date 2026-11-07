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
    // O envio da resposta privada (Graph API) ainda NÃO está implementado.
    // Por isso o evento NÃO vira PROCESSED: a entrega fica PENDING e o evento segue RECEIVED,
    // evitando "processado" sem mensagem enviada. Quando o envio existir, marcar SENT/FAILED/UNKNOWN
    // na entrega e PROCESSED no evento (nunca reenviar às cegas após timeout).
    await prisma.automationEvent.update({
      where: { id: data.eventId },
      data: { organizationId: match.organizationId, socialAccountId: account.id, error: "entrega PENDING: envio ainda não implementado" },
    });
  },
  { connection: { url: env.REDIS_URL } },
);
console.log("worker ouvindo", QUEUES.COMMENT_EVENTS);
