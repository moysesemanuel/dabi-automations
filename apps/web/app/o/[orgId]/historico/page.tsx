import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Automation, History } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { StatusBadge } from "@/components/status";

export const metadata: Metadata = { title: "Histórico" };
type SP = { tipo?: string; status?: string; automacao?: string; pagina?: string };

const STATUS_OPTIONS = [["", "Todos"], ["SENT", "Enviadas"], ["FAILED", "Falhas"], ["UNKNOWN", "Incertas"], ["PENDING", "Aguardando"], ["HELD", "Retidas"]] as const;

function detail(i: History["items"][number]) {
  const p = i.provider;
  const bits: string[] = [];
  if (i.error) bits.push(i.error);
  if (p?.code !== undefined) bits.push(`Código Meta ${p.code}${p.error_subcode ? `/${p.error_subcode}` : ""}`);
  if (p?.fbtrace_id) bits.push(`Rastreio ${p.fbtrace_id}`);
  if (p?.rateLimited) bits.push("Limite de envios da Meta");
  return bits;
}

export default async function HistoryPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<SP> }) {
  const { orgId } = await params;
  const sp = await searchParams;
  const kind = sp.tipo === "publica" ? "publica" : "dm";
  const page = Math.max(1, Number(sp.pagina) || 1);
  const qs = new URLSearchParams({ page: String(page), pageSize: "20" });
  if (sp.status) qs.set("status", sp.status);
  if (sp.automacao) qs.set("automationId", sp.automacao);
  const [h, automations] = await Promise.all([
    apiGet<History>(`/orgs/${orgId}/${kind === "dm" ? "deliveries" : "public-replies"}?${qs}`),
    apiGet<Automation[]>(`/orgs/${orgId}/automations`),
  ]);

  const link = (over: Partial<SP>) => {
    const q = new URLSearchParams();
    const merged = { tipo: kind, status: sp.status, automacao: sp.automacao, pagina: undefined, ...over } as SP;
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, String(v));
    return `/o/${orgId}/historico?${q}`;
  };

  return (
    <>
      <div className="page-head"><div><h1>Histórico</h1><p>Tudo o que as automações enviaram, com o resultado de cada tentativa.</p></div></div>

      <div className="row between">
        <nav className="tabs" aria-label="Tipo de envio">
          <Link href={link({ tipo: "dm", pagina: undefined })} aria-current={kind === "dm" ? "page" : undefined}>Mensagens privadas</Link>
          <Link href={link({ tipo: "publica", pagina: undefined })} aria-current={kind === "publica" ? "page" : undefined}>Respostas públicas</Link>
        </nav>
      </div>

      <form method="get" className="filters" aria-label="Filtros">
        <input type="hidden" name="tipo" value={kind} />
        <div className="field">
          <label htmlFor="f-status">Resultado</label>
          <select id="f-status" name="status" defaultValue={sp.status ?? ""}>
            {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-auto">Automação</label>
          <select id="f-auto" name="automacao" defaultValue={sp.automacao ?? ""}>
            <option value="">Todas</option>
            {automations.map((a) => <option key={a.id} value={a.id}>{a.keyword}</option>)}
          </select>
        </div>
        <button className="btn">Filtrar</button>
        {(sp.status || sp.automacao) && <Link className="btn ghost" href={link({ status: undefined, automacao: undefined })}>Limpar</Link>}
      </form>

      {h.items.length === 0 ? (
        <div className="card empty"><h2>Nada por aqui ainda</h2><p>Quando alguém comentar a palavra-chave de uma automação ativa, o resultado aparece neste histórico.</p></div>
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-labelledby="hist-caption">
          <table>
            <caption id="hist-caption" className="sr-only">{kind === "dm" ? "Mensagens privadas" : "Respostas públicas"}</caption>
            <thead><tr><th>Quando</th><th>Automação</th><th>Resultado</th><th>Tentativas</th><th>Detalhes</th></tr></thead>
            <tbody>
              {h.items.map((i) => (
                <tr key={i.id}>
                  <td data-label="Quando" className="nowrap">{formatDateTime(i.createdAt)}</td>
                  <td data-label="Automação"><strong>{i.automation.keyword}</strong>{i.automation.permalink && <div className="cell-sub"><a className="action-link" href={i.automation.permalink} target="_blank" rel="noopener noreferrer">Ver publicação<span className="sr-only"> (abre em nova aba)</span></a></div>}</td>
                  <td data-label="Resultado"><StatusBadge status={i.status} /></td>
                  <td data-label="Tentativas">{i.attempts}</td>
                  <td data-label="Detalhes">
                    {detail(i).length ? detail(i).map((b) => <div key={b} className="cell-sub">{b}</div>) : <span className="cell-sub">—</span>}
                    {i.status === "UNKNOWN" && <div className="cell-sub"><strong>Confira no Instagram se saiu antes de qualquer ação.</strong></div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <span className="muted">{h.total} {h.total === 1 ? "registro" : "registros"} · página {h.page} de {h.totalPages}</span>
        <div className="row">
          {h.page > 1 ? <Link className="btn small" href={link({ pagina: String(h.page - 1) })}>← Anterior</Link> : <span className="btn small" aria-disabled="true">← Anterior</span>}
          {h.page < h.totalPages ? <Link className="btn small" href={link({ pagina: String(h.page + 1) })}>Próxima →</Link> : <span className="btn small" aria-disabled="true">Próxima →</span>}
        </div>
      </div>
    </>
  );
}
