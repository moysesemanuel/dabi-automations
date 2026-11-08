export type LoginMode = "INSTAGRAM" | "FACEBOOK";

/** Erro "de negócio" ao falar com a Meta. A mensagem nunca contém o token. */
export class MetaApiError extends Error {}

/** FACEBOOK => graph.facebook.com | INSTAGRAM => graph.instagram.com */
export const graphHost = (mode: LoginMode) =>
  mode === "FACEBOOK" ? "https://graph.facebook.com" : "https://graph.instagram.com";

/** `secrets`: valores que nunca podem aparecer em mensagens de erro (token, client_secret, code). */
export async function graphGetJson(url: string, secrets: string | string[], fetchImpl: typeof fetch = fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new MetaApiError("Não foi possível consultar a Meta (rede/timeout).");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    let raw = String(body?.error?.message ?? "sem detalhes");
    for (const sec of [secrets].flat()) if (sec) raw = raw.split(sec).join("[oculto]");
    raw = raw.slice(0, 200);
    const code = body?.error?.code != null ? `, código ${body.error.code}` : "";
    throw new MetaApiError(`Meta rejeitou a requisição (HTTP ${res.status}${code}): ${raw}`);
  }
  return body;
}
