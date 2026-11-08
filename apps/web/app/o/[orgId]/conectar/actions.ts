"use server";
import { api } from "@/lib/api";
import type { OnboardingAnswer, OnboardingStep } from "@/lib/types";

export interface ProgressPatch {
  step?: OnboardingStep;
  professionalAccount?: OnboardingAnswer | null;
  businessPortfolio?: OnboardingAnswer | null;
  instagramInPortfolio?: OnboardingAnswer | null;
}

/** Salva o progresso do assistente (só etapa e respostas). Falha é silenciosa para o usuário: o assistente continua funcionando. */
export async function saveProgress(orgId: string, patch: ProgressPatch): Promise<{ ok: boolean }> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/connection-onboarding`, { method: "PUT", body: patch });
  return { ok: r.ok };
}
