/**
 * Critérios de expiração de entregas (E2: SÓ funções puras e testadas; NENHUMA rotina as chama; a execução é da E3).
 *
 * Princípios:
 * - CANCELED = decisão operacional de não enviar, e só quando se SABE que a Meta não foi chamada:
 *   `HELD` (sempre attempts = 0) e `PENDING` com attempts = 0 (nunca reivindicada). NÃO prova que a Meta não recebeu algo.
 * - `PENDING` com attempts ≥ 1 pode ter chamado a Meta: vira UNKNOWN, nunca CANCELED.
 * - UNKNOWN nunca vira CANCELED nem é reenviada: a ausência de confirmação não prova que não foi enviada. Só o registro
 *   operacional pode ser encerrado depois do prazo, SEMPRE gravando antes o tombstone de idempotência.
 * - Um evento só pode ser apagado quando nenhuma entrega dele ainda é processável (PENDING ou HELD).
 */

export type DeliveryState = "PENDING" | "HELD" | "SENT" | "FAILED" | "UNKNOWN" | "CANCELED";

export interface ExpirableDelivery {
  status: DeliveryState;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExpiryLimits {
  /** PENDING sem progresso por mais que isto é "presa". Padrão: 15 min. */
  pendingStuckMs: number;
  /** HELD mais antiga que isto deixa de ser retomável. Padrão: 30 dias (o evento correspondente também expira). */
  heldMaxAgeMs: number;
  /** Registro operacional (UNKNOWN/SENT/FAILED/CANCELED) encerrado depois disto. Padrão: 90 dias. */
  recordMaxAgeMs: number;
}

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
export const DEFAULT_EXPIRY_LIMITS: ExpiryLimits = { pendingStuckMs: 15 * MIN, heldMaxAgeMs: 30 * DAY, recordMaxAgeMs: 90 * DAY };

export type ExpiryAction =
  | { kind: "none" }
  | { kind: "cancel"; reason: string } // → CANCELED (a Meta comprovadamente não foi chamada)
  | { kind: "markUnknown"; reason: string } // → UNKNOWN (pode ter havido chamada; conservador, sem reenvio)
  | { kind: "purge"; requiresTombstone: true }; // encerrar o registro operacional, gravando o tombstone na MESMA transação

/** "Mais de X": estritamente maior. Exatamente no limite ainda NÃO expira. */
const olderThan = (d: Date, now: Date, ms: number) => now.getTime() - d.getTime() > ms;

export function classifyDeliveryExpiry(row: ExpirableDelivery, now: Date, limits: ExpiryLimits = DEFAULT_EXPIRY_LIMITS): ExpiryAction {
  switch (row.status) {
    case "PENDING":
      if (!olderThan(row.updatedAt, now, limits.pendingStuckMs)) return { kind: "none" };
      return row.attempts === 0
        ? { kind: "cancel", reason: "presa em PENDING sem nunca ter chamado a Meta (attempts = 0); cancelada sem envio" }
        : { kind: "markUnknown", reason: "presa em PENDING após ser reivindicada (attempts ≥ 1): pode ter chamado a Meta; resultado desconhecido, não reenviar" };
    case "HELD":
      if (!olderThan(row.createdAt, now, limits.heldMaxAgeMs)) return { kind: "none" };
      // HELD é sempre attempts = 0. Se não for, o estado é anômalo: não afirmar que nada foi enviado.
      return row.attempts === 0
        ? { kind: "cancel", reason: "retida além do prazo máximo; nunca enviada; cancelada sem envio" }
        : { kind: "markUnknown", reason: "HELD com attempts ≥ 1 (estado anômalo): não é possível afirmar que nada foi enviado" };
    case "UNKNOWN":
    case "SENT":
    case "FAILED":
    case "CANCELED":
      return olderThan(row.updatedAt, now, limits.recordMaxAgeMs) ? { kind: "purge", requiresTombstone: true } : { kind: "none" };
  }
}

/** O evento só pode ser apagado se NENHUMA entrega dele ainda for processável. Resolver o estado antes de apagar. */
export function canPurgeEvent(deliveries: { status: DeliveryState }[]): boolean {
  return deliveries.every((d) => d.status !== "PENDING" && d.status !== "HELD");
}
