"use client";
import { useActionState } from "react";
import type { FormState } from "@/app/o/[orgId]/automacoes/actions";

/** Pausar/reativar. Se a API recusar (ex.: palavra-chave repetida), o motivo aparece ao lado. */
export function StatusToggle({ active, action }: { active: boolean; action: (prev: FormState | undefined) => Promise<FormState> }) {
  const [state, run, pending] = useActionState(action, undefined);
  return (
    <form action={run} className="row">
      <button className="btn small" disabled={pending}>{pending ? "…" : active ? "Pausar" : "Reativar"}</button>
      {state?.error && <span className="cell-sub" role="alert" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}
