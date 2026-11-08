"use client";
import { useActionState } from "react";
import type { ConnectState } from "@/app/o/[orgId]/contas/actions";

export function ConnectInstagram({ action, label, ariaLabel, small }: { action: (prev?: ConnectState) => Promise<ConnectState>; label: string; ariaLabel?: string; small?: boolean }) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="row">
      <button className={`btn primary${small ? " small" : ""}`} disabled={pending} aria-label={ariaLabel}>{pending ? "Abrindo o Instagram…" : label}</button>
      {state?.error && <span className="cell-sub" role="alert" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
