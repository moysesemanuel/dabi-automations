"use server";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { api } from "@/lib/api";

export interface InviteState { error?: string; link?: string; email?: string }
export interface SimpleState { error?: string; ok?: boolean }

/** Origem do painel para montar o link (a API devolve só o token). */
async function origin() {
  if (process.env.WEB_URL) return process.env.WEB_URL.replace(/\/$/, "");
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000"}`;
}

export async function inviteMember(orgId: string, _prev: InviteState | undefined, form: FormData): Promise<InviteState> {
  const email = String(form.get("email") ?? "").trim();
  const role = String(form.get("role") ?? "MEMBER");
  const r = await api<{ token: string; email: string }>(`/orgs/${encodeURIComponent(orgId)}/invitations`, { method: "POST", body: { email, role } });
  if (!r.ok) return { error: r.message, email };
  revalidatePath(`/o/${orgId}/equipe`);
  // O link só existe agora: a API guarda apenas o hash do token.
  return { link: `${await origin()}/convite/${r.data.token}`, email: r.data.email };
}

export async function revokeInvitation(orgId: string, id: string, _prev?: SimpleState): Promise<SimpleState> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/equipe`);
  return { ok: true };
}

export async function removeMember(orgId: string, userId: string, _prev?: SimpleState): Promise<SimpleState> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/equipe`);
  return { ok: true };
}

export async function changeRole(orgId: string, userId: string, _prev: SimpleState | undefined, form: FormData): Promise<SimpleState> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`, { method: "PATCH", body: { role: String(form.get("role") ?? "") } });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/equipe`);
  return { ok: true };
}
