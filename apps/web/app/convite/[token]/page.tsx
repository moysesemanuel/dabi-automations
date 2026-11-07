import type { Metadata } from "next";
import Link from "next/link";
import { publicApi, apiGet } from "@/lib/api";
import { readToken } from "@/lib/session";
import { roleLabel, type Profile, type Role } from "@/lib/types";
import { AcceptExisting, AcceptNew } from "./accept-forms";

export const metadata: Metadata = { title: "Convite" };
interface Preview { organizationName: string; email: string; role: Role; accountExists: boolean }

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const r = await publicApi<Preview>(`/invitations/${encodeURIComponent(token)}`);
  const shell = (children: React.ReactNode) => (
    <main className="auth"><div className="card auth-card"><div className="brand"><span className="brand-mark" aria-hidden="true">D</span> DaBi Automations</div>{children}</div></main>
  );

  if (!r.ok) {
    return shell(<>
      <div><h1>Convite indisponível</h1><p className="muted">Este convite expirou, já foi usado ou foi cancelado. Peça um novo convite a quem administra a organização.</p></div>
      <Link className="btn" href="/login">Ir para o login</Link>
    </>);
  }
  const inv = r.data;
  const intro = <div><h1>Você foi convidado</h1><p className="muted">Para entrar em <strong>{inv.organizationName}</strong> como <strong>{roleLabel[inv.role]}</strong>, usando o e-mail <strong>{inv.email}</strong>.</p></div>;

  if (!inv.accountExists) return shell(<>{intro}<AcceptNew token={token} /></>);

  // Já tem conta: precisa estar logado com o e-mail convidado.
  const hasSession = Boolean(await readToken());
  const me = hasSession ? await apiGet<Profile>("/me/profile").catch(() => null) : null;
  if (me && me.email.toLowerCase() === inv.email) return shell(<>{intro}<AcceptExisting token={token} /></>);
  return shell(<>
    {intro}
    {me && <p className="alert warn" role="status">Você está logado como {me.email}, mas o convite é para {inv.email}. Saia e entre com a conta convidada.</p>}
    <p className="muted">Este e-mail já tem conta. Entre para aceitar o convite.</p>
    <Link className="btn primary" href={`/login?next=${encodeURIComponent(`/convite/${token}`)}`}>Entrar para aceitar</Link>
  </>);
}
