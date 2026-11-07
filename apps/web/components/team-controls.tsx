"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import type { InviteState, SimpleState } from "@/app/o/[orgId]/equipe/actions";

/** Botão com confirmação em diálogo nativo (ações que removem acesso). */
export function ConfirmAction({ label, title, body, confirmLabel, action, className = "btn small danger" }: {
  label: string; title: string; body: string; confirmLabel: string; className?: string;
  action: (prev: SimpleState | undefined) => Promise<SimpleState>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, run, pending] = useActionState(action, undefined);
  useEffect(() => { if (state?.ok) ref.current?.close(); }, [state]);
  return (
    <>
      <button type="button" className={className} onClick={() => ref.current?.showModal()}>{label}</button>
      <dialog ref={ref} aria-labelledby="confirm-title">
        <form action={run} className="dialog-body">
          <h2 id="confirm-title">{title}</h2>
          <p>{body}</p>
          {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
          <div className="actions">
            <button type="button" className="btn" autoFocus onClick={() => ref.current?.close()}>Cancelar</button>
            <button className="btn danger" disabled={pending}>{pending ? "…" : confirmLabel}</button>
          </div>
        </form>
      </dialog>
    </>
  );
}

/** Troca de papel: envia ao escolher uma opção diferente. */
export function RoleSelect({ current, action }: { current: "ADMIN" | "MEMBER"; action: (prev: SimpleState | undefined, form: FormData) => Promise<SimpleState> }) {
  const [state, run, pending] = useActionState(action, undefined);
  const formRef = useRef<HTMLFormElement>(null);
  return (
    <form ref={formRef} action={run} className="row">
      <label className="sr-only" htmlFor={`role-${current}`}>Papel</label>
      <select name="role" defaultValue={current} disabled={pending} onChange={() => formRef.current?.requestSubmit()}>
        <option value="MEMBER">Membro</option>
        <option value="ADMIN">Administrador</option>
      </select>
      {state?.error && <span className="cell-sub" role="alert" style={{ color: "var(--bad)" }}>{state.error}</span>}
    </form>
  );
}

export function InviteDialog({ action }: { action: (prev: InviteState | undefined, form: FormData) => Promise<InviteState> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [key, setKey] = useState(0);
  return (
    <>
      <button type="button" className="btn primary" onClick={() => ref.current?.showModal()}>Convidar pessoa</button>
      <dialog ref={ref} aria-labelledby="invite-title" onClose={() => setKey((k) => k + 1)}>
        <InviteForm key={key} action={action} onClose={() => ref.current?.close()} />
      </dialog>
    </>
  );
}

function InviteForm({ action, onClose }: { action: (prev: InviteState | undefined, form: FormData) => Promise<InviteState>; onClose: () => void }) {
  const [state, run, pending] = useActionState(action, undefined);
  const [copied, setCopied] = useState(false);
  if (state?.link) {
    return (
      <div className="dialog-body">
        <h2 id="invite-title">Convite criado</h2>
        <p>Envie este link para <strong>{state.email}</strong>. Ele vale por 7 dias e só pode ser usado uma vez.</p>
        <div className="field">
          <label htmlFor="invite-link">Link do convite</label>
          <input id="invite-link" type="text" readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} />
          <span className="help">Por segurança, o link aparece só agora. Se perder, crie outro convite.</span>
        </div>
        <div className="actions">
          <button type="button" className="btn" onClick={async () => { try { await navigator.clipboard.writeText(state.link!); setCopied(true); } catch { /* o campo já está selecionável */ } }}>{copied ? "Copiado ✓" : "Copiar link"}</button>
          <button type="button" className="btn primary" onClick={onClose}>Concluir</button>
        </div>
      </div>
    );
  }
  return (
    <form action={run} className="dialog-body">
      <h2 id="invite-title">Convidar pessoa</h2>
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
      <div className="field"><label htmlFor="inv-email">E-mail</label><input id="inv-email" name="email" type="email" required autoFocus defaultValue={state?.email} /></div>
      <div className="field"><label htmlFor="inv-role">Papel</label>
        <select id="inv-role" name="role" defaultValue="MEMBER">
          <option value="MEMBER">Membro (vê tudo, não altera)</option>
          <option value="ADMIN">Administrador (gerencia automações e equipe)</option>
        </select>
      </div>
      <div className="actions">
        <button type="button" className="btn" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={pending}>{pending ? "Criando…" : "Criar convite"}</button>
      </div>
    </form>
  );
}
