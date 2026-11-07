import type { DeliveryStatus } from "@/lib/types";

const MAP: Record<DeliveryStatus, { label: string; cls: string; hint: string }> = {
  SENT: { label: "Enviada", cls: "ok", hint: "A Meta confirmou o envio." },
  FAILED: { label: "Falhou", cls: "bad", hint: "A Meta recusou. Nada foi enviado." },
  UNKNOWN: { label: "Incerta", cls: "warn", hint: "Não sabemos se saiu. Confira no Instagram antes de qualquer ação." },
  PENDING: { label: "Aguardando", cls: "", hint: "Ainda não foi enviada." },
};

export function StatusBadge({ status }: { status: DeliveryStatus }) {
  const s = MAP[status];
  return <span className={`badge ${s.cls}`} title={s.hint}>{s.label}</span>;
}
export const statusLabel = (s: DeliveryStatus) => MAP[s].label;
