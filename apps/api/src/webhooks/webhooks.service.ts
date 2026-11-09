import { Injectable, Logger, Optional } from "@nestjs/common";
import { Queue } from "bullmq";
import { PrismaService } from "../prisma/prisma.module";
import { QUEUES, COMMENT_JOB_FORMATS, jobRetention, type CommentEventJob, type CommentEventJobMinimal, type CommentJobFormat } from "@dabi/contracts";
import { loadEnv } from "@dabi/config";

/** BullMQ não aceita ":" em jobId customizado; a chave do banco continua "comment:<id>". */
export const commentJobId = (commentId: string) => `comment-${commentId}`;
/** Formato mínimo: o jobId usa só o ID interno do evento (nenhum ID da Meta). */
export const eventJobId = (eventId: string) => `evt-${eventId}`;

/**
 * Opções de todo job novo: `attempts`/`backoff` fixos e, SOMENTE se a retenção for habilitada de forma explícita
 * (JOB_RETENTION_ENABLED=true com os dois prazos válidos), removeOnComplete/removeOnFail. Por padrão NENHUM job é removido por
 * idade. Mesma função (`jobRetention`) e mesmas variáveis do worker. Configuração inválida é erro (a API não inicia).
 */
export function buildJobOptions(env: Record<string, string | undefined>) {
  const num = (v: string | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  return {
    attempts: 3,
    backoff: { type: "exponential" as const, delay: 2000 },
    ...jobRetention({ enabled: env.JOB_RETENTION_ENABLED === "true", completedMaxAgeSeconds: num(env.COMPLETED_JOB_MAX_AGE_SECONDS), failedMaxAgeSeconds: num(env.FAILED_JOB_MAX_AGE_SECONDS) }),
  };
}
export const JOB_OPTIONS = buildJobOptions(process.env);

/** Valor inválido ou ausente → "legacy" (o comportamento anterior). Nunca "minimal" por engano. */
export function resolveJobFormat(v: string | undefined): CommentJobFormat {
  return (COMMENT_JOB_FORMATS as readonly string[]).includes(String(v)) ? (v as CommentJobFormat) : "legacy";
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);
  // `opts` existe para os testes. @Optional(): o Nest não tem provedor para ele e injeta undefined (vale o padrão {}).
  constructor(private prisma: PrismaService, @Optional() private opts: { format?: CommentJobFormat; now?: () => Date } = {}) {}

  private _queue?: Queue<CommentEventJob | CommentEventJobMinimal>;
  private get queue() {
    return (this._queue ??= new Queue<CommentEventJob | CommentEventJobMinimal>(QUEUES.COMMENT_EVENTS, {
      connection: { url: loadEnv().REDIS_URL },
    }));
  }

  private format(): CommentJobFormat {
    return this.opts.format ?? resolveJobFormat(process.env.COMMENT_JOB_FORMAT);
  }

  /** Comentário já tratado cujos registros foram apagados: protegido pelo tombstone enquanto ele valer. */
  private async tombstoned(commentId: string): Promise<boolean> {
    const t = await this.prisma.idempotencyTombstone.findUnique({ where: { commentId } });
    if (!t) return false;
    return new Date(t.expiresAt).getTime() > (this.opts.now ?? (() => new Date()))().getTime();
  }

  /**
   * `igAccountId` só é gravado se o ID recebido corresponde a uma conta CONECTADA (com credencial e não desconectada)
   * e vinculada a uma organização. Senão, null: nunca se grava um identificador não validado.
   */
  private async connectedAccountId(igAccountId: string): Promise<string | null> {
    const a = await this.prisma.socialAccount.findUnique({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: igAccountId } },
      select: { organizationId: true, disconnectedAt: true, credential: { select: { id: true } } },
    });
    return a && a.organizationId && !a.disconnectedAt && a.credential ? igAccountId : null;
  }

  async ingest(body: any) {
    // Só a forma do payload (campos e contagens), sem ids, textos ou dados pessoais.
    const fields = (body?.entry ?? []).flatMap((e: any) => (e.changes ?? []).map((c: any) => String(c.field)));
    this.logger.debug(`ingest: object=${body?.object} entries=${body?.entry?.length ?? 0} fields=[${fields.join(",")}]`);
    const format = this.format();

    for (const entry of body?.entry ?? []) {
      for (const change of entry.changes ?? []) {
        // Unified Login envia o id em value.comment_id; o formato anterior (Instagram Login), em value.id.
        const commentId = change.value?.comment_id ?? change.value?.id;
        if (change.field !== "comments" || !commentId) continue;
        const v = change.value;
        const key = `comment:${commentId}`;

        // unique em providerEventKey => reenvio do webhook não duplica o registro
        let ev = await this.prisma.automationEvent.findUnique({ where: { providerEventKey: key } });
        let created = false;
        if (!ev) {
          // Comentário já tratado e apagado pela retenção: não recria o evento (nada é processado de novo).
          if (await this.tombstoned(String(commentId))) {
            this.logger.log(`evento ignorado motivo=dropped.tombstone comentario=${commentId} (sem evento: nenhum ID interno existe)`);
            continue;
          }
          const igAccountId = await this.connectedAccountId(String(entry.id));
          try {
            ev = await this.prisma.automationEvent.create({ data: { providerEventKey: key, payload: change, ...(igAccountId ? { igAccountId } : {}) } });
            created = true;
          } catch (e: any) {
            if (e?.code !== "P2002") throw e;
            ev = await this.prisma.automationEvent.findUnique({ where: { providerEventKey: key } });
          }
        }
        // Já tratado (PROCESSED/IGNORED/FAILED): não reenfileira.
        // Ainda RECEIVED: a tentativa anterior pode ter falhado ao enfileirar, então tenta de novo.
        // O jobId determinístico impede job duplicado no BullMQ.
        if (!ev) continue;
        if (ev.status !== "RECEIVED") {
          // Descarte por deduplicação: visível no log (só id do comentário e estado; nunca texto, token ou dados pessoais).
          // O payload de exemplo do botão "Testar" da Meta usa sempre o mesmo id, então cai aqui.
          this.logger.log(`evento duplicado ignorado por deduplicação (comment:${commentId}, estado atual=${ev.status}) evento=${ev.id}`);
          continue;
        }

        if (format === "minimal") {
          // Evento com conta validada na chegada: o job leva só o ID interno do evento.
          if (ev.igAccountId) {
            await this.queue.add("comment", { eventId: ev.id }, { jobId: eventJobId(ev.id), ...JOB_OPTIONS });
            continue;
          }
          // Evento novo de conta não reconhecida (ou desconectada): nada a processar, sem job e sem dado na fila.
          if (created) {
            await this.prisma.automationEvent.update({ where: { id: ev.id }, data: { status: "IGNORED", error: "conta desconhecida" } });
            this.logger.log(`evento ignorado evento=${ev.id} motivo=ignored.account_unknown`);
            continue;
          }
          // Evento anterior à E2 reentregue: sem igAccountId gravado e SEM preenchimento por inferência → job legado.
        }

        await this.queue.add("comment", {
          eventId: ev.id,
          igAccountId: String(entry.id),
          commentId: String(commentId),
          mediaId: String(v.media?.id ?? ""),
          text: String(v.text ?? ""),
          fromId: v.from?.id ? String(v.from.id) : undefined,
        }, { jobId: commentJobId(String(commentId)), ...JOB_OPTIONS });
      }
    }
  }
}
