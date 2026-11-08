import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { Membership, Profile } from "@/lib/types";
import { Logo } from "@/components/logo";
import { Nav } from "@/components/nav";
import { OrgSwitch } from "@/components/org-switch";
import { ThemeDialog } from "@/components/theme-dialog";
import { logout } from "../../actions";

export default async function OrgLayout({ children, params }: { children: React.ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const [memberships, profile] = await Promise.all([apiGet<Membership[]>("/me"), apiGet<Profile>("/me/profile")]);
  // Só mostra organizações das quais a pessoa participa (a API também confere a cada chamada).
  const current = memberships.find((m) => m.organization.id === orgId);
  if (!current) notFound();

  return (
    <div className="shell">
      <a className="skip-link" href="#conteudo">Pular para o conteúdo</a>
      <aside className="sidebar">
        <div className="brand"><Logo height={32} /></div>
        <OrgSwitch current={orgId} orgs={memberships.map((m) => m.organization)} />
        <Nav orgId={orgId} canManageTeam={current.role === "OWNER" || current.role === "ADMIN"} />
        <div className="side-foot">
          <div className="who">
            <div>{profile.name ?? profile.email}</div>
            <div className="muted">{current.organization.name}</div>
          </div>
          <div className="row">
            <ThemeDialog />
            <form action={logout}><button className="btn ghost small">Sair</button></form>
          </div>
        </div>
      </aside>
      <main className="main" id="conteudo" tabIndex={-1}>{children}</main>
    </div>
  );
}
