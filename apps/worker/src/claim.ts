/**
 * Claim atômico da reserva (última barreira antes de qualquer chamada à Meta).
 *
 * Um ÚNICO UPDATE grava attempts = 1 SOMENTE se a reserva ainda é PENDING com attempts = 0 E não existe tombstone válido para o
 * comentário. Por que no mesmo comando: a retenção apaga os registros de um comentário e grava o tombstone na MESMA transação.
 * Uma reserva nova só consegue ser criada depois que essa exclusão foi confirmada (a unicidade do commentId espera a transação
 * que apaga a linha antiga); logo, quando o claim roda (depois da criação da reserva), o tombstone já é visível. Verificar o
 * tombstone ANTES de reservar não basta: a retenção pode confirmar entre a verificação e a reserva (TOCTOU).
 */
export type ClaimTable = "MessageDelivery" | "PublicReply";

export async function claimReservation(prisma: any, table: ClaimTable, id: string): Promise<boolean> {
  if (typeof prisma.$executeRaw !== "function") {
    // Fakes de teste unitário (sem SQL): mesma semântica de status/attempts; o teste de tombstone vive nos testes de integração.
    const model = table === "MessageDelivery" ? "messageDelivery" : "publicReply";
    const r = await prisma[model].updateMany({ where: { id, status: "PENDING", attempts: 0 }, data: { attempts: 1 } });
    return r.count === 1;
  }
  const n: number = table === "MessageDelivery"
    ? await prisma.$executeRaw`UPDATE "MessageDelivery" SET "attempts" = 1, "updatedAt" = NOW() WHERE "id" = ${id} AND "status" = 'PENDING' AND "attempts" = 0 AND NOT EXISTS (SELECT 1 FROM "IdempotencyTombstone" t WHERE t."commentId" = "MessageDelivery"."commentId" AND t."expiresAt" > NOW()) AND NOT EXISTS (SELECT 1 FROM "RetentionLease" h WHERE h."id" = 'restore-hold' AND h."owner" IS NOT NULL)`
    : await prisma.$executeRaw`UPDATE "PublicReply" SET "attempts" = 1, "updatedAt" = NOW() WHERE "id" = ${id} AND "status" = 'PENDING' AND "attempts" = 0 AND NOT EXISTS (SELECT 1 FROM "IdempotencyTombstone" t WHERE t."commentId" = "PublicReply"."commentId" AND t."expiresAt" > NOW()) AND NOT EXISTS (SELECT 1 FROM "RetentionLease" h WHERE h."id" = 'restore-hold' AND h."owner" IS NOT NULL)`;
  return n === 1;
}

/**
 * Claim recusado: se o motivo foi o tombstone, encerra a reserva (PENDING, attempts 0: a Meta comprovadamente não foi chamada)
 * como CANCELED, em vez de deixá-la presa. Compare-and-set: nunca mexe numa reserva que outra execução já reivindicou.
 */
export async function cancelIfTombstoned(prisma: any, table: ClaimTable, id: string, commentId: string, now: Date): Promise<boolean> {
  const t = await prisma.idempotencyTombstone.findUnique({ where: { commentId } });
  if (!t || new Date(t.expiresAt).getTime() <= now.getTime()) return false;
  const model = table === "MessageDelivery" ? "messageDelivery" : "publicReply";
  const r = await prisma[model].updateMany({ where: { id, status: "PENDING", attempts: 0 }, data: { status: "CANCELED", error: "dropped.tombstone" } });
  return r.count === 1;
}

/**
 * Claim recusado pelo BLOQUEIO PÓS-RESTAURAÇÃO (restore-hold): a reserva (PENDING, attempts 0: a Meta não foi chamada) vira HELD, para
 * poder ser retomada depois da reconciliação, em vez de ficar presa em PENDING. Compare-and-set. Só age se o bloqueio está ativo.
 */
export async function holdIfRestoreHold(prisma: any, table: ClaimTable, id: string): Promise<boolean> {
  const h = await prisma.retentionLease?.findUnique?.({ where: { id: "restore-hold" } });
  if (!h || !h.owner) return false;
  const model = table === "MessageDelivery" ? "messageDelivery" : "publicReply";
  const r = await prisma[model].updateMany({ where: { id, status: "PENDING", attempts: 0 }, data: { status: "HELD", error: "restore.hold" } });
  return r.count === 1;
}
