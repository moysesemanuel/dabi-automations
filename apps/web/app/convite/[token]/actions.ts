"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { api, publicApi } from "@/lib/api";
import { createSession } from "@/lib/session";

export interface InviteState { error?: string; name?: string }

export async function acceptAsNewUser(token: string, _prev: InviteState | undefined, form: FormData): Promise<InviteState> {
  const name = String(form.get("name") ?? "").trim();
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
  const r = await publicApi<{ token: string; organizationId: string }>(`/invitations/${encodeURIComponent(token)}/accept-new`, {
    method: "POST", clientIp: ip, body: { name: name || undefined, password: String(form.get("password") ?? "") },
  });
  if (!r.ok) return { error: r.message, name };
  await createSession(r.data.token);
  redirect(`/o/${r.data.organizationId}`);
}

export async function acceptAsExistingUser(token: string): Promise<InviteState> {
  const r = await api<{ organizationId: string }>(`/invitations/${encodeURIComponent(token)}/accept`, { method: "POST" });
  if (!r.ok) return { error: r.message };
  redirect(`/o/${r.data.organizationId}`);
}
