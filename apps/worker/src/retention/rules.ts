/**
 * Regras PURAS da retenção (sem acesso a dados). Cada comentário é uma UNIDADE: evento, entrega (DM), resposta pública e tombstone
 * são avaliados em conjunto. Decisões preliminares de produto (não exigências universais da LGPD).
 */
import { DEFAULT_EXPIRY_LIMITS, canPurgeEvent, classifyDeliveryExpiry, type DeliveryState } from "../delivery-expiry";

const DAY = 86_400_000;

export const RETENTION_DEFAULTS = {
  eventMaxAgeMs: 30 * DAY,
  recordMaxAgeMs: 90 * DAY, // entregas e respostas públicas
  heldMaxAgeMs: 30 * DAY,
  pendingStuckMs: 15 * 60_000,
  needsReviewAnalysisMs: 30 * DAY, // janela de análise operacional
  needsReviewMaxMs: 90 * DAY, // retenção total máxima; depois, encerramento explícito e só então exclusão
  tombstoneTtlSeconds: 180 * 86_400,
  invitationMs: 7 * DAY,
  auditMs: 180 * DAY,
  retentionRunMs: 365 * DAY,
} as const;

/**
 * Tetos AUTORIZADOS pelo código: aumentar exige autorização específica e uma mudança de código revisada (não é configuração).
 * Lote inicial de no máximo 10 registros.
 */
export const AUTHORIZED_LIMITS = { batchMax: 10, runMaxRows: 100 } as const;

export interface RecordSnap { status: DeliveryState; attempts: number; createdAt: Date; updatedAt: Date }
export interface UnitSnapshot {
  commentId: string;
  event?: { status: string; error: string | null; receivedAt: Date } | null;
  dm?: RecordSnap | null;
  pub?: RecordSnap | null;
}

export type UnitAction =
  | { kind: "none"; reason: string }
  | { kind: "defer"; reason: string } // elegível por idade, mas inseguro agora (processável, em voo, evento pendente)
  | { kind: "transition"; target: "dm" | "pub"; to: "CANCELED" | "UNKNOWN"; reason: string }
  | { kind: "close_review"; reason: string } // needs_review esgotou o prazo: encerramento EXPLÍCITO antes de qualquer exclusão
  | { kind: "overdue_review" } // needs_review além da janela de análise (só relatório; nenhuma alteração)
  | { kind: "purge"; parts: { event: boolean; records: boolean } };

const age = (d: Date, now: Date) => now.getTime() - d.getTime();
const isNeedsReview = (e: UnitSnapshot["event"]) => Boolean(e && e.status === "RECEIVED" && typeof e.error === "string" && e.error.startsWith("needs_review."));

/**
 * Plano de UMA unidade. Devolve ações em ordem de precedência; a execução faz UMA fase por rodada para cada unidade: primeiro resolve
 * estados (transições/encerramento), e só numa rodada posterior exclui. Nenhuma transição produz "não enviada" a partir de UNKNOWN.
 */
export function planUnit(u: UnitSnapshot, now: Date, L = RETENTION_DEFAULTS): UnitAction[] {
  const actions: UnitAction[] = [];

  // 1) Estados presos (PENDING/HELD): resolver ANTES de qualquer exclusão. CAS no executor protege execuções em voo.
  for (const [target, r] of [["dm", u.dm], ["pub", u.pub]] as const) {
    if (!r) continue;
    const a = classifyDeliveryExpiry(r, now, { ...DEFAULT_EXPIRY_LIMITS, pendingStuckMs: L.pendingStuckMs, heldMaxAgeMs: L.heldMaxAgeMs, recordMaxAgeMs: L.recordMaxAgeMs });
    if (a.kind === "cancel") actions.push({ kind: "transition", target, to: "CANCELED", reason: a.reason });
    else if (a.kind === "markUnknown") actions.push({ kind: "transition", target, to: "UNKNOWN", reason: a.reason });
  }
  if (actions.length) return actions; // resolve o estado primeiro; a exclusão fica para uma rodada posterior

  // 2) needs_review: análise até 30 d; até 90 d de retenção; encerramento explícito antes da exclusão.
  if (isNeedsReview(u.event)) {
    const a = age(u.event!.receivedAt, now);
    if (a >= L.needsReviewMaxMs) return [{ kind: "close_review", reason: "prazo máximo de análise esgotado" }];
    if (a >= L.needsReviewAnalysisMs) return [{ kind: "overdue_review" }, { kind: "defer", reason: "needs_review em análise (ainda dentro do prazo máximo)" }];
    return [{ kind: "none", reason: "needs_review dentro da janela de análise" }];
  }

  const dm = u.dm ?? null, pub = u.pub ?? null;
  const processable = !canPurgeEvent([dm, pub].filter(Boolean).map((r) => ({ status: r!.status })));
  const eventOld = Boolean(u.event && age(u.event.receivedAt, now) >= L.eventMaxAgeMs);
  const recordsAll = [dm, pub].filter(Boolean) as RecordSnap[];
  const recordsOld = recordsAll.length > 0 && recordsAll.every((r) => age(r.updatedAt, now) >= L.recordMaxAgeMs);
  const recordsTerminal = recordsAll.every((r) => ["SENT", "FAILED", "CANCELED", "UNKNOWN"].includes(r.status));

  // 3) Registros (DM e resposta pública JUNTOS): ambos terminais e ambos com mais de 90 d. Nunca uma modalidade sozinha.
  if (recordsOld && recordsTerminal) {
    if (u.event && u.event.status === "RECEIVED") return [{ kind: "defer", reason: "evento ainda RECEIVED (processável): resolver antes de apagar as entregas" }];
    return [{ kind: "purge", parts: { event: Boolean(u.event) && eventOld, records: true } }]; // o evento só sai junto se ele próprio já passou do prazo
  }
  if (recordsAll.length > 0 && !recordsTerminal) return [{ kind: "defer", reason: "há entrega ainda não terminal" }];

  // 4) Evento: >30 d e nenhuma entrega processável (PENDING/HELD). As entregas ficam (a unicidade continua barrando duplicidade).
  if (eventOld) {
    if (processable) return [{ kind: "defer", reason: "entrega PENDING/HELD ainda processável" }];
    return [{ kind: "purge", parts: { event: true, records: false } }];
  }
  return [{ kind: "none", reason: "dentro dos prazos" }];
}

/** Tombstones, convites, auditoria e execuções: seletores por data (puros). */
export const cutoff = (now: Date, ms: number) => new Date(now.getTime() - ms);
