"use server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { apiLogin, publicApi } from "@/lib/api";
import { createSession, destroySession } from "@/lib/session";
import { safeNext } from "@/lib/safe-next";

export interface LoginState { error?: string; email?: string }

export async function login(_prev: LoginState | undefined, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Informe e-mail e senha.", email };
  // IP do visitante, repassado à API para o limite de tentativas (a API só confia nele vindo de proxy confiável).
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
  const r = await apiLogin(email, password, ip);
  if (!r.ok) return { error: r.message, email };
  await createSession(r.token);
  redirect(safeNext(String(form.get("next") ?? "")) ?? "/");
}

export interface RegisterState { error?: string; values?: { name?: string; email?: string; organizationName?: string } }

export async function registerAccount(_prev: RegisterState | undefined, form: FormData): Promise<RegisterState> {
  const values = { name: String(form.get("name") ?? "").trim(), email: String(form.get("email") ?? "").trim(), organizationName: String(form.get("organizationName") ?? "").trim() };
  const password = String(form.get("password") ?? "");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim();
  const r = await publicApi<{ token: string; organizationId: string }>("/auth/register", { method: "POST", clientIp: ip, body: { ...values, name: values.name || undefined, password } });
  if (!r.ok) return { error: r.status === 403 ? "O cadastro está fechado neste ambiente." : r.message, values };
  await createSession(r.data.token);
  redirect(`/o/${r.data.organizationId}`);
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
