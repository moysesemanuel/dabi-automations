import "server-only";
import { redirect } from "next/navigation";
import { readToken } from "./session";

/** URL interna da API Nest. Nunca é enviada ao navegador. */
const API_URL = process.env.API_URL ?? "http://localhost:3001";

export type ApiResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; message: string };

/** Mensagem amigável a partir do erro do Nest (string, lista de erros do Zod ou texto). */
function messageFrom(status: number, body: any): string {
  const m = body?.message;
  if (Array.isArray(m)) return m.map((x) => (typeof x === "string" ? x : x?.message)).filter(Boolean).join(" ");
  if (typeof m === "string" && m && status < 500) return m;
  if (status === 403) return "Você não tem permissão para esta ação.";
  if (status === 404) return "Não encontrado.";
  if (status === 409) return "Essa ação conflita com algo que já existe.";
  return "Não foi possível concluir. Tente novamente.";
}

/** Chamada autenticada à API: o token vem do cookie e é anexado aqui, no servidor. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const token = await readToken();
  if (!token) redirect("/login");
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return { ok: false, status: 0, message: "Não foi possível falar com o servidor. Tente novamente em instantes." };
  }
  if (res.status === 401) redirect("/session-expired");
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, status: res.status, message: messageFrom(res.status, body) };
  return { ok: true, status: res.status, data: body as T };
}

/** Para leituras em páginas: erro de permissão/inexistente vira 404; falha técnica sobe para o error boundary. */
export async function apiGet<T>(path: string): Promise<T> {
  const r = await api<T>(path);
  if (r.ok) return r.data;
  if (r.status === 403 || r.status === 404) {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  throw new Error(r.message);
}

export async function apiLogin(email: string, password: string): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }),
      cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => null);
    if (res.ok && body?.token) return { ok: true, token: String(body.token) };
    if (res.status === 401 || res.status === 400) return { ok: false, message: "E-mail ou senha incorretos." };
    return { ok: false, message: "Não foi possível entrar agora. Tente novamente." };
  } catch {
    return { ok: false, message: "Não foi possível falar com o servidor. Tente novamente em instantes." };
  }
}
