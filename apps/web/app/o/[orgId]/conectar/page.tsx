import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { apiGet } from "@/lib/api";
import { roleIn } from "@/lib/org";
import { canWrite, type ConnectionOnboarding } from "@/lib/types";
import { initialStep, isOutcome } from "@/lib/connect-flow";
import { ConnectWizard } from "@/components/connect-wizard";
import { connectInstagram } from "../contas/actions";
import { saveProgress } from "./actions";

export const metadata: Metadata = { title: "Conectar Instagram" };

export default async function ConnectPage({ params, searchParams }: { params: Promise<{ orgId: string }>; searchParams: Promise<{ ig?: string }> }) {
  const { orgId } = await params;
  const { ig } = await searchParams;
  const role = await roleIn(orgId);
  if (!canWrite(role)) notFound(); // a API também recusa; só evita uma tela vazia
  const state = await apiGet<ConnectionOnboarding>(`/orgs/${orgId}/connection-onboarding`);
  const outcome = isOutcome(ig) ? ig : isOutcome(state.lastOutcome) ? state.lastOutcome : null;
  return (
    <ConnectWizard
      orgId={orgId}
      initial={state}
      initialStep={initialStep(state.step, ig)}
      outcome={outcome}
      save={saveProgress.bind(null, orgId)}
      connect={connectInstagram.bind(null, orgId)}
    />
  );
}
