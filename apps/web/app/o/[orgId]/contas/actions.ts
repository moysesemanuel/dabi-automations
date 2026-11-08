"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";

export interface ConnectState { error?: string }

/** Pede à API a URL de autorização da Meta (com state) e leva o usuário até lá. */
export async function connectInstagram(orgId: string, _prev?: ConnectState): Promise<ConnectState> {
  const r = await api<{ url: string }>(`/orgs/${encodeURIComponent(orgId)}/instagram/connect`, { method: "POST" });
  if (!r.ok) return { error: r.status === 503 ? "A conexão com o Instagram ainda não está disponível neste ambiente." : r.message };
  redirect(r.data.url);
}

/** Ativa o recebimento de comentários da conta (assina o webhook). Ação explícita do administrador. */
export async function activateComments(orgId: string, accountId: string, _prev?: ConnectState): Promise<ConnectState> {
  const r = await api<{ status: "SUBSCRIBED" | "FAILED"; error: string | null }>(`/orgs/${encodeURIComponent(orgId)}/accounts/${encodeURIComponent(accountId)}/webhook-subscription`, { method: "POST" });
  if (!r.ok) return { error: r.status === 403 ? "Esta conta ainda não foi liberada para receber comentários neste ambiente." : r.message };
  revalidatePath(`/o/${orgId}/contas`);
  return r.data.status === "SUBSCRIBED" ? {} : { error: r.data.error ?? "Não foi possível ativar. Tente novamente." };
}
