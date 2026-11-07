import type { Metadata } from "next";
import { apiGet } from "@/lib/api";
import type { Account } from "@/lib/types";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = { title: "Contas" };
const DAY = 86_400_000;

function tokenState(c: Account["credential"]): { label: string; cls: string; detail: string } {
  if (!c.connected) return { label: "Sem credencial", cls: "bad", detail: "A conta precisa ser reconectada pela equipe técnica." };
  if (!c.expiresAt) return { label: "Conectada", cls: "ok", detail: "Sem data de expiração informada." };
  const left = new Date(c.expiresAt).getTime() - Date.now();
  if (left <= 0) return { label: "Expirada", cls: "bad", detail: `Expirou em ${formatDate(c.expiresAt)}. Reconecte a conta.` };
  if (left < 7 * DAY) return { label: "Expira em breve", cls: "warn", detail: `Expira em ${formatDate(c.expiresAt)}.` };
  return { label: "Conectada", cls: "ok", detail: `Válida até ${formatDate(c.expiresAt)}.` };
}

export default async function AccountsPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const accounts = await apiGet<Account[]>(`/orgs/${orgId}/accounts`);
  return (
    <>
      <div className="page-head"><div><h1>Contas</h1><p>Contas do Instagram conectadas a esta organização.</p></div></div>

      {accounts.length === 0 ? (
        <div className="card empty"><h2>Nenhuma conta conectada</h2><p>Peça à equipe técnica para conectar a conta do Instagram da sua empresa.</p></div>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="accounts-caption">
          <table>
            <caption id="accounts-caption" className="sr-only">Contas conectadas</caption>
            <thead><tr><th>Conta</th><th>Conexão</th><th>Publicações</th><th>Automações</th></tr></thead>
            <tbody>
              {accounts.map((a) => {
                const t = tokenState(a.credential);
                return (
                  <tr key={a.id}>
                    <td data-label="Conta"><strong>@{a.username}</strong><div className="cell-sub">ID {a.providerAccountId}</div></td>
                    <td data-label="Conexão">
                      <span className={`badge ${t.cls}`}>{t.label}</span>
                      <div className="cell-sub">{t.detail}</div>
                      {a.credential.connected && <div className="cell-sub">Acesso via {a.credential.loginMode === "FACEBOOK" ? "Facebook" : "Instagram"}</div>}
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
        <h2>Como conectar ou reconectar uma conta</h2>
        <p className="muted">Por segurança, a chave de acesso do Instagram nunca passa por esta tela: a conexão é feita pela equipe técnica, direto no servidor, e a chave fica guardada criptografada. Em uma próxima versão você poderá conectar por aqui.</p>
      </section>
    </>
  );
}
