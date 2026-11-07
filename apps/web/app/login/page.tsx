import type { Metadata } from "next";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  return (
    <main className="auth">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">D</span> DaBi Automations</div>
        <div>
          <h1>Entrar</h1>
          <p className="muted">Acesse o painel da sua organização.</p>
        </div>
        {expired && <p className="alert warn" role="status">Sua sessão expirou. Entre novamente.</p>}
        <LoginForm />
      </div>
    </main>
  );
}
