"use server";
import { redirect } from "next/navigation";
import { api } from "@/lib/api";

/** Busca as publicações na Meta (a API usa a credencial guardada; o token não passa por aqui). */
export async function syncMedia(orgId: string, accountId: string) {
  const r = await api<{ synced: number }>(`/orgs/${encodeURIComponent(orgId)}/accounts/${encodeURIComponent(accountId)}/media/sync`, { method: "POST" });
  const q = new URLSearchParams({ conta: accountId });
  if (r.ok) q.set("sincronizadas", String(r.data.synced));
  else q.set("erro", r.message);
  redirect(`/o/${orgId}/publicacoes?${q}`);
}
