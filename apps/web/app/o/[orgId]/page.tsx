import type { Metadata } from "next";
import Link from "next/link";
import { apiGet } from "@/lib/api";
import type { Overview } from "@/lib/types";
import { SendingNotice } from "@/components/sending-notice";

export const metadata: Metadata = { title: "Visão geral" };

export default async function OverviewPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const o = await apiGet<Overview>(`/orgs/${orgId}/overview`);
  const base = `/o/${orgId}`;
  const problems = o.directMessages.FAILED + o.directMessages.UNKNOWN + o.publicReplies.FAILED + o.publicReplies.UNKNOWN;
  const setupDone = o.accounts > 0 && o.media > 0 && o.automations.active + o.automations.paused > 0;

  return (
    <>
      <div className="page-head"><div><h1>Visão geral</h1><p>Como suas automações estão indo.</p></div></div>

      <SendingNotice sending={o.sending} />

      {problems > 0 && (
        <p className="alert warn" role="status">
          {problems} {problems === 1 ? "envio precisa" : "envios precisam"} de atenção. <Link className="action-link" href={`${base}/historico`}>Ver no histórico</Link>
        </p>
      )}

      <section className="stats" aria-label="Resumo">
        <div className="card stat"><span className="label">Contas conectadas</span><span className="num">{o.accounts}</span></div>
        <div className="card stat"><span className="label">Publicações</span><span className="num">{o.media}</span></div>
        <div className="card stat"><span className="label">Automações ativas</span><span className="num">{o.automations.active}</span><span className="hint">{o.automations.paused} pausada(s)</span></div>
        <div className="card stat"><span className="label">Mensagens privadas enviadas</span><span className="num">{o.directMessages.SENT}</span><span className="hint">{o.directMessages.FAILED} falha(s) · {o.directMessages.UNKNOWN} incerta(s)</span></div>
        <div className="card stat"><span className="label">Respostas públicas</span><span className="num">{o.publicReplies.SENT}</span><span className="hint">{o.publicReplies.FAILED} falha(s) · {o.publicReplies.UNKNOWN} incerta(s)</span></div>
      </section>

      {!setupDone && (
        <section className="card">
          <h2>Primeiros passos</h2>
          <ol className="steps">
            <li>{o.accounts > 0 ? "✓ " : ""}Conecte uma conta do Instagram (feito pela equipe técnica; veja em <Link href={`${base}/contas`}>Contas</Link>).</li>
            <li>{o.media > 0 ? "✓ " : ""}Traga as publicações em <Link href={`${base}/publicacoes`}>Publicações</Link>.</li>
            <li>{o.automations.active + o.automations.paused > 0 ? "✓ " : ""}Crie uma automação em <Link href={`${base}/automacoes`}>Automações</Link>.</li>
          </ol>
        </section>
      )}
    </>
  );
}
