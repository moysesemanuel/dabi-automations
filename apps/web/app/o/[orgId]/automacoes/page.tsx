import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import type { Account, Automation, MediaItem, Overview } from "@/lib/types";
import { canWrite } from "@/lib/types";
import { roleIn } from "@/lib/org";
import { AutomationDialog, type MediaOption } from "@/components/automation-dialog";
import { StatusToggle } from "@/components/status-toggle";
import { SendingNotice } from "@/components/sending-notice";
import { createAutomation, setAutomationStatus, updateAutomation } from "./actions";

export const metadata: Metadata = { title: "Automações" };

const mediaLabel = (m: MediaItem) => (m.caption ? m.caption.replace(/\s+/g, " ").slice(0, 60) : `Publicação ${m.providerMediaId}`);

export default async function AutomationsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ publicacao?: string }> }) {
  const { orgId } = await params;
  const { publicacao } = await searchParams;
  const [role, automations, accounts, media, overview] = await Promise.all([
    roleIn(orgId),
    apiGet<Automation[]>(`/orgs/${orgId}/automations`),
    apiGet<Account[]>(`/orgs/${orgId}/accounts`),
    apiGet<MediaItem[]>(`/orgs/${orgId}/media`),
    apiGet<Overview>(`/orgs/${orgId}/overview`),
  ]);
  const writable = canWrite(role);
  const options: MediaOption[] = media.map((m) => ({ id: m.id, socialAccountId: m.socialAccountId, label: mediaLabel(m) }));
  const canCreate = writable && accounts.length > 0 && media.length > 0;

  return (
    <>
      <div className="page-head">
        <div><h1>Automações</h1><p>O que acontece quando alguém comenta uma palavra-chave.</p></div>
        {canCreate && <AutomationDialog mode="create" action={createAutomation.bind(null, orgId)} accounts={accounts} media={options} defaultMediaId={publicacao} defaultOpen={Boolean(publicacao)} triggerLabel="Nova automação" />}
      </div>

      <SendingNotice sending={overview.sending} />
      {!writable && <p className="alert">Você pode ver as automações, mas só administradores podem criar ou alterar.</p>}

      {automations.length === 0 ? (
        <div className="card empty">
          <h2>Nenhuma automação ainda</h2>
          <p>{media.length === 0 ? "Primeiro traga as publicações em “Publicações”." : "Crie a primeira para responder automaticamente a um comentário."}</p>
        </div>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="auto-caption">
          <table>
            <caption id="auto-caption" className="sr-only">Automações</caption>
            <thead><tr><th>Palavra-chave</th><th>Publicação</th><th>O que faz</th><th>Estado</th>{writable && <th>Ações</th>}</tr></thead>
            <tbody>
              {automations.map((a) => (
                <tr key={a.id}>
                  <td data-label="Palavra-chave"><strong>{a.keyword}</strong></td>
                  <td data-label="Publicação">{a.media.permalink ? <a href={a.media.permalink} target="_blank" rel="noopener noreferrer">Ver publicação</a> : a.media.providerMediaId}</td>
                  <td data-label="O que faz">
                    <div className="row">
                      {a.dmEnabled && <span className="badge accent">{a.replyFormat === "BUTTON" ? "DM com botão" : "DM com texto"}</span>}
                      {a.publicReplyEnabled && <span className="badge accent">Resposta pública</span>}
                    </div>
                    {a.dmEnabled && <div className="cell-sub clamp">{a.replyMessage}</div>}
                  </td>
                  <td data-label="Estado"><span className={`badge ${a.status === "ACTIVE" ? "ok" : ""}`}>{a.status === "ACTIVE" ? "Ativa" : "Pausada"}</span></td>
                  {writable && (
                    <td data-label="Ações">
                      <div className="row">
                        <AutomationDialog mode="edit" action={updateAutomation.bind(null, orgId, a.id)} initial={a} triggerLabel="Editar" triggerClass="btn small" />
                        <StatusToggle active={a.status === "ACTIVE"} action={setAutomationStatus.bind(null, orgId, a.id, a.status === "ACTIVE" ? "PAUSED" : "ACTIVE")} />
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
