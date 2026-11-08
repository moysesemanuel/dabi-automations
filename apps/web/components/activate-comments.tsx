"use client";
import { useActionState } from "react";
import type { ConnectState } from "@/app/o/[orgId]/contas/actions";

export function ActivateComments({ action, username, retry }: { action: (prev?: ConnectState) => Promise<ConnectState>; username: string; retry: boolean }) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run}>
      <button className="btn small" disabled={pending} aria-label={`${retry ? "Tentar ativar de novo" : "Ativar"} recebimento de comentários de @${username}`}>{pending ? "Ativando…" : retry ? "Tentar de novo" : "Ativar recebimento de comentários"}</button>
      {state?.error && <div className="cell-sub" role="alert" style={{ color: "var(--bad)" }}>{state.error}</div>}
    </form>
  );
}
