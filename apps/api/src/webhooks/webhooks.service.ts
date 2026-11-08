import { Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.module";
import { QUEUES, type CommentEventJob } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";

/** BullMQ não aceita ":" em jobId customizado; a chave do banco continua "comment:<id>". */
export const commentJobId = (commentId: string) => `comment-${commentId}`;

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  constructor(private prisma: PrismaService) {}

  private _queue?: Queue<CommentEventJob>;
  private get queue() {
    return (this._queue ??= new Queue<CommentEventJob>(QUEUES.COMMENT_EVENTS, {
      connection: { url: loadEnv().REDIS_URL },
    }));
  }

  async ingest(body: any) {
    // Só a forma do payload (campos e contagens), sem ids, textos ou dados pessoais.
    const fields = (body?.entry ?? []).flatMap((e: any) => (e.changes ?? []).map((c: any) => String(c.field)));
    this.logger.debug(`ingest: object=${body?.object} entries=${body?.entry?.length ?? 0} fields=[${fields.join(",")}]`);

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Unified Login envia o id em value.comment_id; o formato anterior (Instagram Login), em value.id.
        const commentId = change.value?.comment_id ?? change.value?.id;
        if (change.field !== "comments" || !commentId) continue;
        const v = change.value;
        const key = `comment:${commentId}`;

        // unique em providerEventKey => reenvio do webhook não duplica o registro
        let ev = await this.prisma.automationEvent.findUnique({ where: { providerEventKey: key } });
        if (!ev) {
          try {
            ev = await this.prisma.automationEvent.create({ data: { providerEventKey: key, payload: change } });
          } catch (e: any) {
            if (e?.code !== "P2002") throw e;
            ev = await this.prisma.automationEvent.findUnique({ where: { providerEventKey: key } });
          }
        }
        // Já tratado (PROCESSED/IGNORED/FAILED): não reenfileira.
        // Ainda RECEIVED: a tentativa anterior pode ter falhado ao enfileirar, então tenta de novo.
        // O jobId determinístico impede job duplicado no BullMQ.
        if (!ev || ev.status !== "RECEIVED") continue;

        await this.queue.add("comment", {
          eventId: ev.id,
          igAccountId: String(entry.id),
          commentId: String(commentId),
          mediaId: String(v.media?.id ?? ""),
          text: String(v.text ?? ""),
          fromId: v.from?.id ? String(v.from.id) : undefined,
        }, { jobId: commentJobId(String(commentId)), attempts: 3, backoff: { type: "exponential", delay: 2000 } });
      }
    }
  }
}
