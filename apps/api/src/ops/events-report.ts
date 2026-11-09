/**
 * Consulta ADMINISTRATIVA de eventos para operadores (suporte técnico). Não existe rota HTTP: roda por linha de comando com as
 * credenciais do servidor (`pnpm --filter @dabi/api ops:events -- ...`), então só quem tem acesso ao ambiente a executa, e nenhum
 * cliente pode alcançá-la pela API. Cobre o que o painel do cliente NÃO mostra: eventos `dropped` e eventos SEM organização.
 *
 * Saída: só IDs internos, estado, código de razão e datas. NUNCA texto do comentário, autor, payload, tokens nem IDs da Meta.
 */
import { deriveEventView, eventReasonFromNote } from "@dabi/contracts";

export type OpsKind = "needs_review" | "dropped" | "no_org" | "all";
export interface OpsQuery { kind?: OpsKind; since?: Date; limit?: number; organizationId?: string }
export interface OpsRow {
  id: string; receivedAt: Date; status: string; kind: string; reason: string | null; state: string;
  organizationId: string | null; socialAccountId: string | null; hasIgAccountId: boolean;
}

const MAX = 200;

export function parseSince(v: string | undefined, now = new Date()): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d+)([mhd])$/.exec(v.trim());
  if (m) return new Date(now.getTime() - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]);
  const d = new Date(v); return Number.isNaN(d.getTime()) ? undefined : d;
}

/** `where` do Prisma para cada tipo. `organizationId` (opcional) restringe a UMA organização: nunca mistura organizações. */
export function opsWhere(q: OpsQuery) {
  const base: Record<string, unknown> = {};
  if (q.since) base.receivedAt = { gte: q.since };
  if (q.organizationId) base.organizationId = q.organizationId;
  switch (q.kind ?? "all") {
    case "needs_review": return { ...base, error: { startsWith: "needs_review." } };
    case "dropped": return { ...base, error: { startsWith: "dropped." } };
    case "no_org": return { ...base, organizationId: null }; // sempre SEM organização (a combinação com --org é recusada)
    default: return base;
  }
}

export async function queryOperatorEvents(prisma: any, q: OpsQuery): Promise<OpsRow[]> {
  if (q.kind === "no_org" && q.organizationId) throw new Error("--kind no_org não pode ser combinado com --org (eventos sem organização não pertencem a nenhuma)");
  const take = Math.min(Math.max(Math.trunc(q.limit ?? 50) || 50, 1), MAX);
  const rows = await prisma.automationEvent.findMany({
    where: opsWhere(q), orderBy: { receivedAt: "desc" }, take,
    // payload NÃO é selecionado: nenhum dado do comentário chega a este código.
    select: { id: true, receivedAt: true, status: true, error: true, organizationId: true, socialAccountId: true, igAccountId: true },
  });
  return rows.map((e: any) => {
    const v = deriveEventView(e);
    return { id: e.id, receivedAt: e.receivedAt, status: e.status, kind: v.state, reason: eventReasonFromNote(e.error), state: v.state, organizationId: e.organizationId ?? null, socialAccountId: e.socialAccountId ?? null, hasIgAccountId: Boolean(e.igAccountId) };
  });
}
