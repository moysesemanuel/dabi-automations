"use server";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";

export interface ConnectState { error?: string }

/** Pede à API a URL de autorização da Meta (com state) e leva o usuário até lá. */
export async function connectInstagram(orgId: string, _prev?: ConnectState): Promise<ConnectState> {
  const r = await api<{ url: string }>(`/orgs/${encodeURIComponent(orgId)}/instagram/connect`, { method: "POST" });
  if (!r.ok) return { error: r.status === 503 ? "A conexão com o Instagram ainda não está disponível neste ambiente." : r.message };
  redirect(r.data.url);
}
