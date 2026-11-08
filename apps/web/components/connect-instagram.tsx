"use client";
import { useActionState } from "react";
import type { ConnectState } from "@/app/o/[orgId]/contas/actions";

export function ConnectInstagram({ action, label }: { action: (prev?: ConnectState) => Promise<ConnectState>; label: string }) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="row">
      <button className="btn primary" disabled={pending}>{pending ? "Abrindo o Instagram…" : label}</button>
      {state?.error && <span className="cell-sub" role="alert" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
