import { Injectable } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.module";
import { QUEUES, type CommentEventJob } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";

@Injectable()
export class WebhooksService {
  constructor(private prisma: PrismaService) {}
  private queue = new Queue<CommentEventJob>(QUEUES.COMMENT_EVENTS, {
    connection: { url: loadEnv().REDIS_URL },
  });

  async ingest(body: any) {
    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field !== "comments" || !change.value?.id) continue;
        const v = change.value;
        const key = `comment:${v.id}`;
        try {
          // unique em providerEventKey => reenvio do webhook não duplica
          const ev = await this.prisma.automationEvent.create({
            data: { providerEventKey: key, payload: change },
          });
          await this.queue.add("comment", {
            eventId: ev.id,
            igAccountId: String(entry.id),
            commentId: String(v.id),
            mediaId: String(v.media?.id ?? ""),
            text: String(v.text ?? ""),
          }, { jobId: key, attempts: 3, backoff: { type: "exponential", delay: 2000 } });
        } catch (e: any) {
          if (e?.code === "P2002") continue; // duplicado: ignora
          throw e;
        }
      }
    }
  }
}
