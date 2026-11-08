import type { GuideId } from "./connect-guides";
import type { ConnectionOnboarding, OnboardingAnswer, OnboardingStep } from "./types";

export type Question = "professionalAccount" | "businessPortfolio" | "instagramInPortfolio";

export const QUESTIONS: { key: Question; label: string; hint: string }[] = [
  { key: "professionalAccount", label: "Seu Instagram é uma conta profissional?", hint: "Empresa ou Criador de conteúdo (não pessoal)." },
  { key: "businessPortfolio", label: "Você tem um portfólio empresarial da Meta?", hint: "É o cadastro da sua empresa na Meta (antes chamado Business Manager)." },
  { key: "instagramInPortfolio", label: "O Instagram já está dentro desse portfólio?", hint: "A conta precisa fazer parte do portfólio para o DaBiChat acessá-la." },
];

/** Qual guia mostrar para cada resposta. "Sim" não mostra nada; "Não" e "Não sei" mostram o guia certo. */
export function guideFor(q: Question, a: OnboardingAnswer | null): GuideId | null {
  if (a !== "NO" && a !== "UNSURE") return null;
  if (q === "professionalAccount") return "professional";
  if (q === "businessPortfolio") return a === "NO" ? "portfolio-create" : "portfolio-find";
  return "instagram-in-portfolio";
}

export const allReady = (s: Pick<ConnectionOnboarding, Question>) => QUESTIONS.every((q) => s[q.key] === "YES");

export type Outcome =
  | "connected" | "partial" | "already_connected" | "other_organization" | "cancelled"
  | "expired" | "forbidden" | "insufficient_permissions" | "no_accounts" | "unavailable" | "error";

export interface OutcomeInfo { tone: "ok" | "warn" | "bad"; title: string; body: string; guides: GuideId[]; retry: boolean; help: boolean }

export const OUTCOMES: Record<Outcome, OutcomeInfo> = {
  connected: { tone: "ok", title: "Conta conectada", body: "Tudo certo. Agora você pode ver a conta em “Contas” e criar suas automações.", guides: [], retry: false, help: false },
  partial: { tone: "warn", title: "Conectamos parte das contas", body: "Algumas contas já estavam conectadas ou pertencem a outra organização e não foram alteradas.", guides: [], retry: false, help: true },
  already_connected: { tone: "warn", title: "Essa conta já estava conectada", body: "Nada foi alterado: a conexão existente continua funcionando.", guides: [], retry: false, help: false },
  other_organization: { tone: "bad", title: "Essa conta já está em outra organização", body: "Cada conta do Instagram só pode ser usada em uma organização do DaBiChat. Fale com a nossa equipe para resolver.", guides: [], retry: false, help: true },
  cancelled: { tone: "warn", title: "Conexão cancelada", body: "Você saiu antes de concluir. Nenhuma conta foi conectada e nada foi alterado.", guides: [], retry: true, help: false },
  expired: { tone: "bad", title: "O pedido expirou", body: "Por segurança, o pedido de conexão vale por 10 minutos e só pode ser usado uma vez. Comece de novo.", guides: [], retry: true, help: false },
  forbidden: { tone: "bad", title: "Sem permissão para conectar", body: "Só proprietários e administradores da organização podem conectar contas.", guides: [], retry: false, help: true },
  insufficient_permissions: { tone: "bad", title: "Faltaram permissões", body: "Na tela da Meta, mantenha marcadas todas as permissões pedidas (comentários, mensagens e informações básicas). Sem elas o DaBiChat não consegue responder.", guides: [], retry: true, help: true },
  no_accounts: { tone: "warn", title: "Não encontramos nenhuma conta do Instagram", body: "Na tela da Meta, escolha o portfólio que contém o seu Instagram. Se ele não aparecer, a conta provavelmente ainda não está no portfólio.", guides: ["portfolio-find", "instagram-in-portfolio", "professional"], retry: true, help: true },
  unavailable: { tone: "bad", title: "Serviço indisponível", body: "Não foi possível concluir agora. Tente novamente em instantes.", guides: [], retry: true, help: true },
  error: { tone: "bad", title: "Não foi possível conectar", body: "Algo deu errado do lado da conexão. Confira os requisitos e tente de novo. Se continuar, fale com a nossa equipe.", guides: ["professional", "portfolio-find", "instagram-in-portfolio"], retry: true, help: true },
};

export const isOutcome = (v: unknown): v is Outcome => typeof v === "string" && v in OUTCOMES;

/** Etapa inicial: um retorno da Meta (?ig=) leva ao resultado; senão, retoma de onde parou. */
export function initialStep(saved: OnboardingStep, ig?: string): OnboardingStep {
  if (isOutcome(ig)) return "RESULT";
  return saved;
}

export const helpHref = (email: string) => `mailto:${email}?subject=${encodeURIComponent("Ajuda para conectar o Instagram")}`;
