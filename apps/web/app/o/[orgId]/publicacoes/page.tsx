import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Account, Automation, MediaItem } from "@/lib/types";
import { canWrite } from "@/lib/types";
import { roleIn } from "@/lib/org";
import { syncMedia } from "./actions";

export const metadata: Metadata = { title: "Publicações" };
type SP = { conta?: string; sincronizadas?: string; erro?: string };
const TYPE: Record<string, string> = { IMAGE: "Foto", VIDEO: "Vídeo", CAROUSEL_ALBUM: "Carrossel", REELS: "Reels" };

export default async function MediaPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<SP> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const [accounts, role] = await Promise.all([apiGet<Account[]>(`/orgs/${orgId}/accounts`), roleIn(orgId)]);
  const account = accounts.find((a) => a.id === sp.conta) ?? accounts[0];
  const [media, automations] = account
    ? await Promise.all([apiGet<MediaItem[]>(`/orgs/${orgId}/media?accountId=${encodeURIComponent(account.id)}`), apiGet<Automation[]>(`/orgs/${orgId}/automations`)])
    : [[] as MediaItem[], [] as Automation[]];
  const byMedia = new Map<string, Automation[]>();
  for (const a of automations) byMedia.set(a.mediaId, [...(byMedia.get(a.mediaId) ?? []), a]);
  const writable = canWrite(role);

  return (
    <>
      <div className="page-head">
        <div><h1>Publicações</h1><p>Escolha em qual publicação a automação vai agir.</p></div>
        {account && writable && (
          <form action={syncMedia.bind(null, orgId, account.id)}><button className="btn primary">Sincronizar publicações</button></form>
        )}
      </div>

      {sp.sincronizadas && <p className="alert ok" role="status">{sp.sincronizadas} {sp.sincronizadas === "1" ? "publicação atualizada" : "publicações atualizadas"}.</p>}
      {sp.erro && <p className="alert bad" role="alert">{sp.erro}</p>}

      {accounts.length > 1 && (
        <form method="get" className="filters">
          <div className="field"><label htmlFor="conta">Conta</label>
            <select id="conta" name="conta" defaultValue={account?.id}>{accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}</select>
          </div>
          <button className="btn">Ver</button>
        </form>
      )}

      {!account ? (
        <div className="card empty"><h2>Conecte uma conta primeiro</h2><p>As publicações aparecem aqui depois que a conta do Instagram for conectada.</p><Link className="action-link" href={`/o/${orgId}/contas`}>Ir para Contas</Link></div>
      ) : media.length === 0 ? (
        <div className="card empty"><h2>Nenhuma publicação ainda</h2><p>{writable ? "Use “Sincronizar publicações” para trazer as publicações de @" + account.username + "." : "Peça a um administrador para sincronizar as publicações."}</p></div>
      ) : (
        <div className="grid-cards">
          {media.map((m) => {
            const autos = byMedia.get(m.id) ?? [];
            return (
              <article key={m.id} className="card thumb">
                <div className="row between">
                  <span className="badge accent">{TYPE[m.mediaType ?? ""] ?? m.mediaType ?? "Publicação"}</span>
                  {m.permalink && <a href={m.permalink} target="_blank" rel="noopener noreferrer">Abrir no Instagram ↗</a>}
                </div>
                <p className="clamp">{m.caption || <span className="muted">Sem legenda</span>}</p>
                <div className="row">
                  {autos.map((a) => <span key={a.id} className={`badge ${a.status === "ACTIVE" ? "ok" : ""}`}>{a.keyword}{a.status === "PAUSED" ? " (pausada)" : ""}</span>)}
                </div>
                {writable && <Link className="btn small" href={`/o/${orgId}/automacoes?publicacao=${m.id}`}>{autos.length ? "Nova automação" : "Criar automação"}</Link>}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
