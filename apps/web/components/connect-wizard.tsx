"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import type { ConnectState } from "@/app/o/[orgId]/contas/actions";
import type { ProgressPatch } from "@/app/o/[orgId]/conectar/actions";
import { GUIDES, type GuideId } from "@/lib/connect-guides";
import { OUTCOMES, QUESTIONS, allReady, guideFor, helpHref, type Outcome, type Question } from "@/lib/connect-flow";
import type { ConnectionOnboarding, OnboardingAnswer, OnboardingStep } from "@/lib/types";
import { ConnectInstagram } from "./connect-instagram";

const STEPS: { key: OnboardingStep; label: string }[] = [
  { key: "PREPARE", label: "Preparação" },
  { key: "CONNECT", label: "Conexão" },
  { key: "RESULT", label: "Resultado" },
];
const ANSWERS: { value: OnboardingAnswer; label: string }[] = [{ value: "YES", label: "Sim" }, { value: "NO", label: "Não" }, { value: "UNSURE", label: "Não sei" }];

function GuideCard({ id }: { id: GuideId }) {
  const g = GUIDES[id];
  return (
    <details className="guide" open>
      <summary>{g.title}</summary>
      <p className="muted">{g.intro}</p>
      <ol>{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
      {g.tips.length > 0 && <ul className="tips">{g.tips.map((t) => <li key={t}>{t}</li>)}</ul>}
      <p>{g.links.map((l, i) => <span key={l.url}>{i > 0 && " · "}<a href={l.url} target="_blank" rel="noopener noreferrer">{l.label}</a></span>)}</p>
    </details>
  );
}

export function ConnectWizard({ orgId, initial, initialStep, outcome, save, connect }: {
  orgId: string;
  initial: ConnectionOnboarding;
  initialStep: OnboardingStep;
  outcome: Outcome | null;
  save: (patch: ProgressPatch) => Promise<{ ok: boolean }>;
  connect: (prev?: ConnectState) => Promise<ConnectState>;
}) {
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [answers, setAnswers] = useState<Record<Question, OnboardingAnswer | null>>({ professionalAccount: initial.professionalAccount, businessPortfolio: initial.businessPortfolio, instagramInPortfolio: initial.instagramInPortfolio });
  const [, startSave] = useTransition();
  const go = (s: OnboardingStep) => { setStep(s); startSave(() => { void save({ step: s }); }); };
  const answer = (q: Question, v: OnboardingAnswer) => { setAnswers((a) => ({ ...a, [q]: v })); startSave(() => { void save({ [q]: v }); }); };
  const info = outcome ? OUTCOMES[outcome] : null;
  const help = initial.helpEmail ? <a className="btn" href={helpHref(initial.helpEmail)}>Falar com a equipe</a> : null;

  return (
    <>
      <div className="page-head"><div><h1>Conectar Instagram</h1><p>Em poucos passos. Você pode voltar, pular as orientações e retomar depois, até de outro aparelho.</p></div>
        {step === "PREPARE" && <button className="btn" type="button" onClick={() => go("CONNECT")}>Já tenho tudo, conectar</button>}
      </div>

      <nav aria-label="Etapas"><ol className="wizard-steps">
        {STEPS.map((s, i) => (
          <li key={s.key}><button type="button" className="wizard-step" aria-current={s.key === step ? "step" : undefined} onClick={() => setStep(s.key)}><span className="n">{i + 1}</span>{s.label}</button></li>
        ))}
      </ol></nav>

      {step === "PREPARE" && (
        <section className="card" aria-labelledby="prep-h">
          <h2 id="prep-h">Antes de conectar</h2>
          <p className="muted">Responda o que souber. Se algo faltar, mostramos como resolver.</p>
          {QUESTIONS.map((q) => {
            const g = guideFor(q.key, answers[q.key]);
            return (
              <div key={q.key} className="question-wrap"><fieldset className="question">
                <legend>{q.label}</legend>
                <p className="muted">{q.hint}</p>
                <div className="segmented" role="radiogroup" aria-label={q.label}>
                  {ANSWERS.map((a) => (
                    <label key={a.value}><input type="radio" name={q.key} value={a.value} checked={answers[q.key] === a.value} onChange={() => answer(q.key, a.value)} /><span>{a.label}</span></label>
                  ))}
                </div>
                {g && <GuideCard id={g} />}
              </fieldset></div>
            );
          })}
          {allReady(answers) && <div className="alert ok" role="status">Tudo pronto para conectar.</div>}
          <div className="row"><button className="btn primary" type="button" onClick={() => go("CONNECT")}>{allReady(answers) ? "Continuar" : "Continuar mesmo assim"}</button>{help}</div>
        </section>
      )}

      {step === "CONNECT" && (
        <section className="card" aria-labelledby="conn-h">
          <h2 id="conn-h">Conectar com a Meta</h2>
          <p>Você vai para o site da Meta (dona do Instagram) e volta para cá. O DaBi nunca vê a sua senha.</p>
          <ol className="meta-steps">
            <li>Entre com o seu Facebook ou Instagram.</li>
            <li>Escolha o <strong>portfólio empresarial</strong> da sua empresa.</li>
            <li>Escolha a <strong>conta do Instagram</strong> que quer conectar.</li>
            <li>Revise as permissões e mantenha todas marcadas (comentários, mensagens e informações básicas). Se aparecer a opção de permitir acesso às mensagens, deixe ativada.</li>
          </ol>
          <div className="row"><ConnectInstagram action={connect} label="Conectar com a Meta" /><button className="btn" type="button" onClick={() => go("PREPARE")}>Voltar</button>{help}</div>
          <p className="muted">Se a Meta não mostrar o seu portfólio ou a sua conta, volte e confira a preparação.</p>
        </section>
      )}

      {step === "RESULT" && (
        <section className="card" aria-labelledby="res-h">
          <h2 id="res-h">Resultado</h2>
          {!info ? (
            <>
              <p className="muted">Ainda não houve nenhuma tentativa de conexão.</p>
              <div className="row"><button className="btn primary" type="button" onClick={() => go("CONNECT")}>Ir para a conexão</button></div>
            </>
          ) : (
            <>
              <div className={`alert ${info.tone}`} role="status"><strong>{info.title}</strong><div>{info.body}</div></div>
              {info.guides.map((id) => <GuideCard key={id} id={id} />)}
              <div className="row">
                {outcome === "connected" || outcome === "partial" || outcome === "already_connected" ? <Link className="btn primary" href={`/o/${orgId}/contas`}>Ver minhas contas</Link> : null}
                {info.retry && <button className="btn primary" type="button" onClick={() => go("CONNECT")}>Tentar de novo</button>}
                <button className="btn" type="button" onClick={() => go("PREPARE")}>Rever a preparação</button>
                {info.help && help}
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
