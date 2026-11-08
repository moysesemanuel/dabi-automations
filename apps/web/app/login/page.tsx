import type { Metadata } from "next";
import Link from "next/link";
import { registrationOpen } from "@/lib/api";
import { safeNext } from "@/lib/safe-next";
import { Logo } from "@/components/logo";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Entrar" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string; next?: string }> }) {
  const { expired, next } = await searchParams;
  const open = await registrationOpen();
  return (
    <main className="auth">
      <div className="card auth-card">
        <div className="brand"><Logo height={36} /></div>
        <div>
          <h1>Entrar</h1>
          <p className="muted">Acesse o painel da sua organização.</p>
        </div>
        {expired && <p className="alert warn" role="status">Sua sessão expirou. Entre novamente.</p>}
        <LoginForm next={safeNext(next) ?? undefined} />
        {open && <p className="muted">Primeiro acesso? <Link href="/cadastro">Criar conta</Link></p>}
      </div>
    </main>
  );
}
