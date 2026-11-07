import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.module";
import { QUEUES, type CommentEventJob } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";

/** BullMQ não aceita ":" em jobId customizado; a chave do banco continua "comment:<id>". */
export const commentJobId = (commentId: string) => `comment-${commentId}`;

@Injectable()
export class WebhooksService {
  constructor(private prisma: PrismaService) {}

  private _queue?: Queue<CommentEventJob>;
  private get queue() {
    return (this._queue ??= new Queue<CommentEventJob>(QUEUES.COMMENT_EVENTS, {
      connection: { url: loadEnv().REDIS_URL },
    }));
  }

  async ingest(body: any) {
    // TEMPORÁRIO (diagnóstico do payload): remover depois de validar a integração. Só estrutura, sem texto nem ids de comentário.
    console.log("[INGEST] Diagnóstico:", {
      object: body?.object,
      entryCount: body?.entry?.length ?? 0,
      entries: (body?.entry ?? []).map((entry: any) => ({
        accountId: entry.id,
        changeCount: entry.changes?.length ?? 0,
        changes: (entry.changes ?? []).map((change: any) => ({
          field: change.field,
          hasId: Boolean(change.value?.id),
          hasText: typeof change.value?.text === "string",
        })),
      })),
    });

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments" || !change.value?.id) continue;
        const v = change.value;
        const key = `comment:${v.id}`;

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
          commentId: String(v.id),
          mediaId: String(v.media?.id ?? ""),
          text: String(v.text ?? ""),
        }, { jobId: commentJobId(String(v.id)), attempts: 3, backoff: { type: "exponential", delay: 2000 } });
      }
    }
  }
}
