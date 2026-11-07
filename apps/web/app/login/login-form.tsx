"use client";
import { useActionState } from "react";
import { login } from "../actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="form-grid">
      {next && <input type="hidden" name="next" value={next} />}
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
      <div className="field">
        <label htmlFor="email">E-mail</label>
        <input id="email" name="email" type="email" autoComplete="username" required defaultValue={state?.email} autoFocus />
      </div>
      <div className="field">
        <label htmlFor="password">Senha</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      <button className="btn primary" disabled={pending}>{pending ? "Entrando…" : "Entrar"}</button>
    </form>
  );
}
