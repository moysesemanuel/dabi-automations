"use server";
import { redirect } from "next/navigation";
import { apiLogin } from "@/lib/api";
import { createSession, destroySession } from "@/lib/session";

export interface LoginState { error?: string; email?: string }

export async function login(_prev: LoginState | undefined, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Informe e-mail e senha.", email };
  const r = await apiLogin(email, password);
  if (!r.ok) return { error: r.message, email };
  await createSession(r.token);
  redirect("/");
}

export async function logout() {
  await destroySession();
  redirect("/login");
}
