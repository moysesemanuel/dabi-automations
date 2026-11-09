import { deriveEventView } from "@dabi/contracts";
import type { DeliveryStatus } from "@/lib/types";

// A explicação de cada estado vem do MESMO catálogo que a API e os logs usam (deriveEventView em @dabi/contracts).
const hint = (s: DeliveryStatus) => deriveEventView({ status: "PROCESSED" }, { status: s }).detail;

const MAP: Record<DeliveryStatus, { label: string; cls: string; hint: string }> = {
  SENT: { label: "Enviada", cls: "ok", hint: hint("SENT") },
  FAILED: { label: "Falhou", cls: "bad", hint: hint("FAILED") },
  UNKNOWN: { label: "Não confirmada", cls: "warn", hint: hint("UNKNOWN") },
  HELD: { label: "Retida", cls: "warn", hint: hint("HELD") },
  PENDING: { label: "Aguardando", cls: "", hint: hint("PENDING") },
  CANCELED: { label: "Cancelada", cls: "", hint: hint("CANCELED") },
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const s = MAP[status];
  return <span className={`badge ${s.cls}`} title={s.hint}>{s.label}</span>;
}
export const statusLabel = (s: DeliveryStatus) => MAP[s].label;
