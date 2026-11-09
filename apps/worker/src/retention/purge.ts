import { randomUUID } from "node:crypto";

/**
 * Primitiva atômica da retenção para UM comentário: grava/renova o tombstone e apaga os registros SELECIONADOS, tudo na transação
 * `tx` recebida. Ou tudo acontece, ou nada. A decisão de ELEGIBILIDADE não é desta função (é do seletor e do executor, que a
 * reavaliam dentro da mesma transação); aqui só se garante a atomicidade tombstone + exclusão.
 *
 * Tombstone: INSERT … ON CONFLICT DO UPDATE com GREATEST: nunca ENCURTA uma proteção já existente.
 */
export interface PurgeParts { event?: boolean; records?: boolean } // records = MessageDelivery E PublicReply juntos (as duas modalidades)
export interface PurgeResult { events: number; deliveries: number; replies: number }

export async function purgeCommentUnit(tx: any, commentId: string, parts: PurgeParts, tombstoneTtlSeconds: number): Promise<PurgeResult> {
  if (!parts.event && !parts.records) return { events: 0, deliveries: 0, replies: 0 };
  await tx.$executeRaw`INSERT INTO "IdempotencyTombstone" ("id", "commentId", "createdAt", "expiresAt") VALUES (${randomUUID()}, ${commentId}, NOW(), NOW() + make_interval(secs => ${tombstoneTtlSeconds})) ON CONFLICT ("commentId") DO UPDATE SET "expiresAt" = GREATEST("IdempotencyTombstone"."expiresAt", EXCLUDED."expiresAt")`;
  const out: PurgeResult = { events: 0, deliveries: 0, replies: 0 };
  if (parts.event) out.events = (await tx.automationEvent.deleteMany({ where: { providerEventKey: `comment:${commentId}` } })).count;
  if (parts.records) {
    // As DUAS modalidades saem juntas: apagar só uma deixaria a outra sem a sua contraparte de proteção.
    out.deliveries = (await tx.messageDelivery.deleteMany({ where: { commentId } })).count;
    out.replies = (await tx.publicReply.deleteMany({ where: { commentId } })).count;
  }
  return out;
}

/** Conveniência para testes e para o executor: roda a primitiva numa transação própria. */
export function purgeCommentUnitTx(prisma: any, commentId: string, parts: PurgeParts, ttlSeconds: number) {
  return prisma.$transaction((tx: any) => purgeCommentUnit(tx, commentId, parts, ttlSeconds));
}
