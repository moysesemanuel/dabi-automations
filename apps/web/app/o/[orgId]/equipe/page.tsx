import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import { canWrite, roleLabel, type Invitation, type Member, type Profile } from "@/lib/types";
import { roleIn } from "@/lib/org";
import { formatDate } from "@/lib/format";
import { ConfirmAction, InviteDialog, RoleSelect } from "@/components/team-controls";
import { changeRole, inviteMember, removeMember, revokeInvitation } from "./actions";

export const metadata: Metadata = { title: "Equipe" };

export default async function TeamPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const role = await roleIn(orgId);
  if (!canWrite(role)) notFound(); // a API também recusa (403); aqui só evitamos uma tela vazia
  const [members, invitations, me] = await Promise.all([
    apiGet<Member[]>(`/orgs/${orgId}/members`),
    apiGet<Invitation[]>(`/orgs/${orgId}/invitations`),
    apiGet<Profile>("/me/profile"),
  ]);
  const isOwner = role === "OWNER";

  return (
    <>
      <div className="page-head">
        <div><h1>Equipe</h1><p>Quem tem acesso a esta organização.</p></div>
        <InviteDialog action={inviteMember.bind(null, orgId)} />
      </div>

      <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="members-caption">
        <table>
          <caption id="members-caption" className="sr-only">Membros</caption>
          <thead><tr><th>Pessoa</th><th>Papel</th><th>Ações</th></tr></thead>
          <tbody>
            {members.map((m) => {
              const self = m.userId === me.id;
              const canRemove = !self && (isOwner || m.role === "MEMBER");
              return (
                <tr key={m.userId}>
                  <td data-label="Pessoa"><strong>{m.name ?? m.email}</strong>{self && <span className="badge accent" style={{ marginInlineStart: ".5rem" }}>você</span>}<div className="cell-sub">{m.email}</div></td>
                  <td data-label="Papel">
                    {isOwner && m.role !== "OWNER" ? <RoleSelect current={m.role as "ADMIN" | "MEMBER"} action={changeRole.bind(null, orgId, m.userId)} /> : <span className="badge">{roleLabel[m.role]}</span>}
                  </td>
                  <td data-label="Ações">
                    {canRemove ? <ConfirmAction label="Remover" title={`Remover ${m.name ?? m.email}?`} body="A pessoa perde o acesso a esta organização na hora. Você pode convidá-la de novo depois." confirmLabel="Remover" action={removeMember.bind(null, orgId, m.userId)} /> : <span className="cell-sub">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <section aria-labelledby="inv-h" className="form-grid">
        <h2 id="inv-h">Convites pendentes</h2>
        {invitations.length === 0 ? <p className="muted">Nenhum convite pendente.</p> : (
          <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="inv-caption">
            <table>
              <caption id="inv-caption" className="sr-only">Convites pendentes</caption>
              <thead><tr><th>E-mail</th><th>Papel</th><th>Validade</th><th>Ações</th></tr></thead>
              <tbody>
                {invitations.map((i) => (
                  <tr key={i.id}>
                    <td data-label="E-mail">{i.email}</td>
                    <td data-label="Papel"><span className="badge">{roleLabel[i.role]}</span></td>
                    <td data-label="Validade">{i.expired ? <span className="badge bad">Expirado</span> : `até ${formatDate(i.expiresAt)}`}</td>
                    <td data-label="Ações"><ConfirmAction label="Cancelar convite" title="Cancelar este convite?" body={`O link enviado para ${i.email} deixa de funcionar.`} confirmLabel="Cancelar convite" action={revokeInvitation.bind(null, orgId, i.id)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
