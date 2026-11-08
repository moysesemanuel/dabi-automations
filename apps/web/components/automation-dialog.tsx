"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BUTTON_TITLE_MAX, PUBLIC_REPLY_MAX, TEMPLATE_TITLE_MAX, validateReplyShape } from "@dabi/contracts";
import type { Account, Automation } from "@/lib/types";
import type { FormState } from "@/app/o/[orgId]/automacoes/actions";

export interface MediaOption { id: string; socialAccountId: string; label: string }
type Action = (prev: FormState | undefined, form: FormData) => Promise<FormState>;

interface Props {
  mode: "create" | "edit";
  action: Action;
  accounts?: Pick<Account, "id" | "username">[];
  media?: MediaOption[];
  initial?: Automation;
  defaultMediaId?: string;
  defaultOpen?: boolean;
  triggerLabel: string;
  ariaLabel?: string;
  triggerClass?: string;
}

export function AutomationDialog(p: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const pathname = usePathname();
  const [formKey, setFormKey] = useState(0);

  useEffect(() => { if (p.defaultOpen) ref.current?.showModal(); }, [p.defaultOpen]);

  const close = () => {
    setFormKey((k) => k + 1); // limpa o formulário para a próxima abertura
    if (p.defaultOpen) router.replace(pathname); // tira ?publicacao= da URL
  };

  return (
    <>
      <button type="button" className={p.triggerClass ?? "btn primary"} aria-label={p.ariaLabel} onClick={() => ref.current?.showModal()}>{p.triggerLabel}</button>
      <dialog ref={ref} className="wide" aria-labelledby={`dlg-${p.initial?.id ?? "new"}`} onClose={close}>
        <AutomationForm key={formKey} {...p} onDone={() => ref.current?.close()} />
      </dialog>
    </>
  );
}

function AutomationForm({ mode, action, accounts = [], media = [], initial, defaultMediaId, onDone }: Props & { onDone: () => void }) {
  const [state, run, pending] = useActionState(action, undefined);
  const defMedia = media.find((m) => m.id === defaultMediaId);
  const [accountId, setAccountId] = useState(defMedia?.socialAccountId ?? initial?.socialAccountId ?? accounts[0]?.id ?? "");
  const [mediaId, setMediaId] = useState(defMedia?.id ?? "");
  const [keyword, setKeyword] = useState(initial?.keyword ?? "");
  const [dm, setDm] = useState(initial?.dmEnabled ?? true);
  const [format, setFormat] = useState<"TEXT" | "BUTTON">(initial?.replyFormat ?? "TEXT");
  const [message, setMessage] = useState(initial?.replyMessage ?? "");
  const [link, setLink] = useState(initial?.linkUrl ?? "");
  const [btn, setBtn] = useState(initial?.buttonTitle ?? "");
  const [pub, setPub] = useState(initial?.publicReplyEnabled ?? false);
  const [pubMsg, setPubMsg] = useState(initial?.publicReplyMessage ?? "");

  useEffect(() => { if (state?.ok) onDone(); }, [state, onDone]);

  // Dica imediata com a MESMA função de validação da API (regra única em @dabi/contracts).
  const hint = validateReplyShape({ replyFormat: format, replyMessage: message, linkUrl: link || null, buttonTitle: btn || null, dmEnabled: dm, publicReplyEnabled: pub, publicReplyMessage: pubMsg });
  const accountMedia = media.filter((m) => m.socialAccountId === accountId);
  const id = `dlg-${initial?.id ?? "new"}`;

  return (
    <form action={run} className="dialog-body">
      <div className="dialog-head">
        <h2 id={id}>{mode === "create" ? "Nova automação" : "Editar automação"}</h2>
        <button type="button" className="btn ghost small" onClick={onDone} aria-label="Fechar">✕</button>
      </div>
      {state?.error && <p className="alert bad" role="alert">{state.error}</p>}

      {mode === "create" && (
        <>
          {accounts.length > 1 && (
            <div className="field"><label htmlFor={`${id}-acc`}>Conta</label>
              <select id={`${id}-acc`} name="socialAccountId" value={accountId} onChange={(e) => { setAccountId(e.target.value); setMediaId(""); }}>
                {accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}
              </select>
            </div>
          )}
          {accounts.length <= 1 && <input type="hidden" name="socialAccountId" value={accountId} />}
          <div className="field"><label htmlFor={`${id}-media`}>Publicação</label>
            <select id={`${id}-media`} name="mediaId" required value={mediaId} onChange={(e) => setMediaId(e.target.value)}>
              <option value="" disabled>Escolha a publicação…</option>
              {accountMedia.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </div>
        </>
      )}

      <div className="field"><label htmlFor={`${id}-kw`}>Palavra-chave</label>
        <input id={`${id}-kw`} name="keyword" type="text" required maxLength={50} value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="Ex.: LINK" />
        <span className="help">Quando alguém comentar uma frase com esta palavra, a automação age. Maiúsculas e acentos não importam.</span>
      </div>

      <fieldset>
        <legend>Mensagem privada (DM)</legend>
        <label className="check"><input type="checkbox" name="dmEnabled" checked={dm} onChange={(e) => setDm(e.target.checked)} /><span>Enviar uma mensagem privada para quem comentou</span></label>
        <div className="field"><span className="label">Formato</span>
          <label className="check"><input type="radio" name="replyFormat" value="TEXT" checked={format === "TEXT"} onChange={() => setFormat("TEXT")} disabled={!dm} /><span>Texto (o link vai junto da mensagem)</span></label>
          <label className="check"><input type="radio" name="replyFormat" value="BUTTON" checked={format === "BUTTON"} onChange={() => setFormat("BUTTON")} disabled={!dm} /><span>Com botão clicável</span></label>
        </div>
        <div className="field"><label htmlFor={`${id}-msg`}>Mensagem</label>
          <textarea id={`${id}-msg`} name="replyMessage" value={message} onChange={(e) => setMessage(e.target.value)} disabled={!dm} maxLength={1000} />
          {format === "BUTTON" && dm && <span className="counter">{message.length}/{TEMPLATE_TITLE_MAX} (limite do formato com botão)</span>}
        </div>
        <div className="field"><label htmlFor={`${id}-link`}>Link</label>
          <input id={`${id}-link`} name="linkUrl" type="url" value={link} onChange={(e) => setLink(e.target.value)} disabled={!dm} placeholder="https://…" />
          {format === "BUTTON" && <span className="help">No formato com botão o link precisa começar com https.</span>}
        </div>
        {format === "BUTTON" && (
          <div className="field"><label htmlFor={`${id}-btn`}>Texto do botão</label>
            <input id={`${id}-btn`} name="buttonTitle" type="text" value={btn} onChange={(e) => setBtn(e.target.value)} disabled={!dm} maxLength={BUTTON_TITLE_MAX} placeholder="Acessar" />
            <span className="counter">{btn.length}/{BUTTON_TITLE_MAX}</span>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Resposta pública</legend>
        <label className="check"><input type="checkbox" name="publicReplyEnabled" checked={pub} onChange={(e) => setPub(e.target.checked)} /><span>Responder publicamente ao comentário</span></label>
        <div className="field"><label htmlFor={`${id}-pub`}>Mensagem da resposta</label>
          <textarea id={`${id}-pub`} name="publicReplyMessage" value={pubMsg} onChange={(e) => setPubMsg(e.target.value)} disabled={!pub} maxLength={PUBLIC_REPLY_MAX} placeholder="Prontinho! Te enviei o link no direct." />
          <span className="help">Com a mensagem privada ligada, a resposta pública só é publicada depois que a mensagem privada for confirmada como enviada.</span>
          <span className="counter">{pubMsg.length}/{PUBLIC_REPLY_MAX}</span>
        </div>
      </fieldset>

      {hint && message.length + pubMsg.length + link.length > 0 && <p className="alert warn" role="status">{hint}</p>}
      <div className="actions">
        <button type="button" className="btn" onClick={onDone}>Cancelar</button>
        <button className="btn primary" disabled={pending}>{pending ? "Salvando…" : "Salvar"}</button>
      </div>
    </form>
  );
}
