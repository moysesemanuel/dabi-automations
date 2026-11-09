import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import type { Account } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { roleIn } from "@/lib/org";
import { canWrite } from "@/lib/types";
import Link from "next/link";
import { ActivateComments } from "@/components/activate-comments";
import { ConnectInstagram } from "@/components/connect-instagram";
import { activateComments, reconnectInstagram } from "./actions";

export const metadata: Metadata = { title: "Contas" };
const DAY = 86_400_000;

const IG_MESSAGES: Record<string, { cls: "ok" | "warn" | "bad"; text: string }> = {
  connected: { cls: "ok", text: "Conta conectada com sucesso." },
  reconnected: { cls: "ok", text: "Conta reconectada com sucesso. As entregas retidas continuam retidas até você liberar o envio." },
  reconnect_mismatch: { cls: "bad", text: "A conta autorizada na Meta não é a que você quis reconectar. Escolha a mesma conta e tente de novo." },
  partial: { cls: "warn", text: "Algumas contas foram conectadas; outras já estavam conectadas ou pertencem a outra organização." },
  already_connected: { cls: "warn", text: "Essa conta já estava conectada. Nada foi alterado." },
  other_organization: { cls: "bad", text: "Essa conta do Instagram já está conectada a outra organização." },
  cancelled: { cls: "warn", text: "Conexão cancelada. Nenhuma conta foi conectada." },
  expired: { cls: "bad", text: "O pedido de conexão expirou ou já foi usado. Comece de novo." },
  forbidden: { cls: "bad", text: "Você não tem permissão para conectar contas nesta organização." },
  insufficient_permissions: { cls: "bad", text: "Faltaram permissões. Autorize todas as permissões solicitadas (comentários e mensagens) e tente de novo." },
  no_accounts: { cls: "warn", text: "Nenhuma conta do Instagram foi encontrada nessa autorização." },
  unavailable: { cls: "bad", text: "Serviço indisponível no momento. Tente novamente em instantes." },
  error: { cls: "bad", text: "Não foi possível conectar a conta. Tente novamente." },
};

function tokenState(c: Account["credential"]): { label: string; cls: string; detail: string } {
  if (!c.connected) return { label: "Sem credencial", cls: "bad", detail: "A conta precisa ser reconectada pela equipe técnica." };
  if (c.status === "NEEDS_RECONNECT") return { label: "Precisa reconectar", cls: "bad", detail: "A Meta recusou o acesso desta conta (credencial revogada ou inválida). Enquanto isso, nenhuma mensagem é enviada por ela." };
  if (!c.expiresAt) return { label: "Conectada", cls: "ok", detail: "Sem data de expiração informada." };
  const left = new Date(c.expiresAt).getTime() - Date.now();
  if (left <= 0) return { label: "Expirada", cls: "bad", detail: `Expirou em ${formatDate(c.expiresAt)}. Reconecte a conta.` };
  if (left < 7 * DAY) return { label: "Expira em breve", cls: "warn", detail: `Expira em ${formatDate(c.expiresAt)}.` };
  return { label: "Conectada", cls: "ok", detail: `Válida até ${formatDate(c.expiresAt)}.` };
}

export default async function AccountsPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ ig?: string }> }) {
  const { orgId } = await params;
  const { ig } = await searchParams;
  const flash = ig ? IG_MESSAGES[ig] : undefined;
  const role = await roleIn(orgId);
  const writable = canWrite(role);
  const accounts = await apiGet<Account[]>(`/orgs/${orgId}/accounts`);
  return (
    <>
      <div className="page-head"><div><h1>Contas</h1><p>Contas do Instagram conectadas a esta organização.</p></div>
        {canWrite(role) && <Link className="btn primary" href={`/o/${orgId}/conectar`}>Conectar conta do Instagram</Link>}
      </div>
      {flash && <div className={`alert ${flash.cls}`} role="status">{flash.text}</div>}

      {accounts.length === 0 ? (
        <div className="card empty"><h2>Nenhuma conta conectada</h2><p>{canWrite(role) ? "Use o botão acima para conectar sua conta do Instagram (precisa ser profissional: comercial ou criador)." : "Peça a um administrador para conectar sua conta do Instagram (precisa ser profissional: comercial ou criador)."}</p></div>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="accounts-caption">
          <table>
            <caption id="accounts-caption" className="sr-only">Contas conectadas</caption>
            <thead><tr><th>Conta</th><th>Conexão</th><th>Comentários</th><th>Publicações</th><th>Automações</th></tr></thead>
            <tbody>
              {accounts.map((a) => {
                const t = tokenState(a.credential);
                return (
                  <tr key={a.id}>
                    <td data-label="Conta"><strong>@{a.username}</strong><div className="cell-sub">ID {a.providerAccountId}</div></td>
                    <td data-label="Conexão">
                      <span className={`badge ${t.cls}`}>{t.label}</span>
                      <div className="cell-sub">{t.detail}</div>
                      {a.credential.connected && a.credential.status === "NEEDS_RECONNECT" && writable && <ConnectInstagram small action={reconnectInstagram.bind(null, orgId, a.id)} label="Reconectar" ariaLabel={`Reconectar @${a.username}`} />}
                      {a.credential.connected && <div className="cell-sub">Acesso via {a.credential.loginMode === "FACEBOOK" ? "Facebook" : "Instagram"}</div>}
                    </td>
                    <td data-label="Comentários">
                      {a.webhookStatus === "SUBSCRIBED" ? (<><span className="badge ok">Ativo</span>{a.webhookSubscribedAt && <div className="cell-sub">desde {formatDate(a.webhookSubscribedAt)}</div>}</>)
                        : a.webhookStatus === "FAILED" ? (<><span className="badge bad">Falhou</span><div className="cell-sub">{a.webhookError}</div></>)
                        : <><span className="badge">Não ativado</span><div className="cell-sub">Sem isto, os comentários não chegam ao DaBiChat.</div></>}
                      {writable && a.webhookStatus !== "SUBSCRIBED" && a.credential.connected && a.credential.status !== "NEEDS_RECONNECT" && <ActivateComments action={activateComments.bind(null, orgId, a.id)} username={a.username} retry={a.webhookStatus === "FAILED"} />}
                    </td>
                    <td data-label="Publicações">{a.mediaCount}</td>
                    <td data-label="Automações">{a.automationCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <section className="card">
        <h2>Sobre a conexão</h2>
        <p className="muted">Você autoriza no site do Instagram/Meta: a chave de acesso nunca passa por esta tela e fica guardada criptografada. Contas já conectadas não são alteradas por este fluxo.</p>
      </section>
    </>
  );
}
