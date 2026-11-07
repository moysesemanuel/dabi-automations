import Link from "next/link";

export default function NotFound() {
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Página não encontrada</h1>
        <p className="muted">O endereço não existe ou você não tem acesso a ele.</p>
        <Link className="btn primary" href="/">Voltar ao início</Link>
      </div>
    </main>
  );
}
