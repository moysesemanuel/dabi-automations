"use client";
import { useActionState } from "react";
import { registerAccount } from "../actions";

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAccount, undefined);
  return (
    <form action={action} className="form-grid">
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}
      <div className="field"><label htmlFor="name">Seu nome</label><input id="name" name="name" type="text" autoComplete="name" defaultValue={state?.values?.name} /></div>
      <div className="field"><label htmlFor="organizationName">Nome da empresa</label><input id="organizationName" name="organizationName" type="text" required minLength={2} maxLength={100} defaultValue={state?.values?.organizationName} /></div>
      <div className="field"><label htmlFor="email">E-mail</label><input id="email" name="email" type="email" autoComplete="username" required defaultValue={state?.values?.email} /></div>
      <div className="field"><label htmlFor="password">Senha</label>
        <input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} maxLength={128} aria-describedby="pw-help" />
        <span id="pw-help" className="help">Pelo menos 10 caracteres.</span>
      </div>
      <button className="btn primary" disabled={pending}>{pending ? "Criando…" : "Criar conta"}</button>
    </form>
  );
}
