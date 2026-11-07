"use client";
import { useActionState } from "react";
import { acceptAsExistingUser, acceptAsNewUser } from "./actions";

export function AcceptNew({ token }: { token: string }) {
  const [state, action, pending] = useActionState(acceptAsNewUser.bind(null, token), undefined);
  return (
    <form action={action} className="form-grid">
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
      <div className="field"><label htmlFor="name">Seu nome</label><input id="name" name="name" type="text" autoComplete="name" defaultValue={state?.name} /></div>
      <div className="field"><label htmlFor="password">Crie uma senha</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby="pw-help" />
        <span id="pw-help" className="help">Pelo menos 10 caracteres.</span>
      </div>
      <button className="btn primary" disabled={pending}>{pending ? "Entrando…" : "Aceitar convite"}</button>
    </form>
  );
}

export function AcceptExisting({ token }: { token: string }) {
  const [state, action, pending] = useActionState(() => acceptAsExistingUser(token), undefined);
  return (
    <form action={action} className="form-grid">
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
      <button className="btn primary" disabled={pending}>{pending ? "Aceitando…" : "Aceitar convite"}</button>
    </form>
  );
}
