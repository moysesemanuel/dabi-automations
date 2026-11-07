export type LoginMode = "INSTAGRAM" | "FACEBOOK";

/** Erro "de negócio" ao falar com a Meta. A mensagem nunca contém o token. */
export class MetaApiError extends Error {}

/** FACEBOOK => graph.facebook.com | INSTAGRAM => graph.instagram.com */
export const graphHost = (mode: LoginMode) =>
  mode === "FACEBOOK" ? "https://graph.facebook.com" : "https://graph.instagram.com";

export async function graphGetJson(url: string, token: string, fetchImpl: typeof fetch = fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MetaApiError("Não foi possível consultar a Meta (rede/timeout).");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = String(body?.error?.message ?? "sem detalhes").split(token).join("[token]").slice(0, 200);
    const code = body?.error?.code != null ? `, código ${body.error.code}` : "";
    throw new MetaApiError(`Meta rejeitou a requisição (HTTP ${res.status}${code}): ${raw}`);
  }
  return body;
}
