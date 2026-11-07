import type { Overview } from "@/lib/types";

/** Avisa quando o servidor não está enviando nada, para ninguém achar que a automação "quebrou". */
export function SendingNotice({ sending }: { sending: Overview["sending"] }) {
  if (sending.directMessages && sending.publicReplies) return null;
  const off = [!sending.directMessages && "mensagens privadas", !sending.publicReplies && "respostas públicas"].filter(Boolean).join(" e ");
  return (
    <p className="alert warn" role="status">
      O envio de {off} está <strong>desligado</strong> neste ambiente. Você pode configurar tudo normalmente, mas nada será enviado até a equipe técnica ativar.
    </p>
  );
}
