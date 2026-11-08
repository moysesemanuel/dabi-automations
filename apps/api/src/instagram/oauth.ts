import { createHash, randomBytes } from "node:crypto";
import { ConnectError, connectInstagramAccount } from "./instagram-connect";
import { MetaApiError, graphGetJson } from "./graph";

/**
 * OAuth de conexão de contas do Instagram via Unified Login (Facebook Login for Business, config_id).
 * Fluxo: API gera a URL (com `state`) -> cliente autoriza na Meta -> Meta volta em /instagram/callback (web)
 * -> web chama a API -> API consome o `state`, troca o code por token e descobre as contas.
 */

export const STATE_TTL_SECONDS = 600;
export const REQUIRED_PERMISSIONS = ["instagram_basic", "instagram_manage_messages", "instagram_manage_comments"] as const;
const MAX_ACCOUNTS = 25;

export interface StatePayload { userId: string; organizationId: string }

/** Armazena o `state` só pelo hash. `take` lê E apaga numa operação atômica (uso único). */
export interface OAuthStateStore {
  put(key: string, payload: StatePayload, ttlSeconds: number): Promise<void>;
  take(key: string): Promise<StatePayload | null>;
}

export class MemoryOAuthStateStore implements OAuthStateStore {
  private m = new Map<string, { payload: StatePayload; exp: number }>();
  constructor(private now: () => number = Date.now) {}
  async put(key: string, payload: StatePayload, ttl: number) { this.m.set(key, { payload, exp: this.now() + ttl * 1000 }); }
  async take(key: string) {
    const e = this.m.get(key);
    this.m.delete(key); // síncrono: duas chamadas concorrentes nunca recebem o mesmo state
    return e && e.exp > this.now() ? e.payload : null;
  }
}

export interface OAuthEnv {
  appId: string;
  appSecret: string;
  configId: string;
  redirectUri: string;
  graphVersion: string;
  tokenEncryptionKey: string;
}

export interface OAuthDeps {
  prisma: any;
  store: OAuthStateStore;
  env: OAuthEnv;
  fetchImpl?: typeof fetch;
}

/** Falhas que impedem iniciar o fluxo (viram HTTP 4xx/5xx na API). */
export class OAuthError extends Error {
  constructor(readonly code: "not_configured" | "forbidden" | "store_unavailable", message: string) { super(message); }
}

export type OAuthOutcome =
  | "connected" | "partial" | "already_connected" | "other_organization"
  | "cancelled" | "expired" | "forbidden" | "insufficient_permissions" | "no_accounts" | "error";

export interface OAuthResult {
  outcome: OAuthOutcome;
  /** Só presente quando o `state` era válido e do usuário: o web usa para redirecionar. */
  organizationId?: string;
  connected: { id: string; username: string }[];
  skipped: { username: string; reason: "already_connected" | "other_organization" | "error" }[];
}

const hashState = (state: string) => `ig-oauth:${createHash("sha256").update(state).digest("hex")}`;
const fail = (outcome: OAuthOutcome, organizationId?: string): OAuthResult => ({ outcome, organizationId, connected: [], skipped: [] });

/** HTTPS é exigido pela Meta; localhost só vale se a própria Meta aceitar (confirmar no painel). */
export function resolveRedirectUri(webUrl: string, explicit: string): string {
  return explicit || `${webUrl.replace(/\/+$/, "")}/instagram/callback`;
}

async function assertCanConnect(prisma: any, userId: string, organizationId: string) {
  const m = await prisma.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
  return Boolean(m && (m.role === "OWNER" || m.role === "ADMIN"));
}

export async function startInstagramOAuth(deps: OAuthDeps, input: { userId: string; organizationId: string }): Promise<{ url: string }> {
  const { env } = deps;
  if (!env.appId || !env.appSecret || !env.configId) throw new OAuthError("not_configured", "Conexão com o Instagram não configurada neste ambiente.");
  if (!/^https:\/\//i.test(env.redirectUri)) throw new OAuthError("not_configured", "A URL de retorno do Instagram precisa ser HTTPS.");
  if (!(await assertCanConnect(deps.prisma, input.userId, input.organizationId))) throw new OAuthError("forbidden", "Apenas proprietários e administradores podem conectar contas.");

  const state = randomBytes(32).toString("base64url");
  try {
    await deps.store.put(hashState(state), { userId: input.userId, organizationId: input.organizationId }, STATE_TTL_SECONDS);
  } catch {
    // Sem onde guardar o state não há como validar o retorno: não inicia o fluxo.
    throw new OAuthError("store_unavailable", "Serviço temporariamente indisponível. Tente novamente.");
  }
  const q = new URLSearchParams({ client_id: env.appId, config_id: env.configId, redirect_uri: env.redirectUri, response_type: "code", state });
  return { url: `https://www.facebook.com/dialog/oauth?${q}` };
}

export interface CompleteInput { userId: string; state: string; code?: string; error?: string; errorReason?: string }

export async function completeInstagramOAuth(deps: OAuthDeps, input: CompleteInput): Promise<OAuthResult> {
  const { env, prisma } = deps;

  // 1) state: uso único, expira em 10 min. Consumido ANTES de qualquer outra coisa (também em cancelamento/erro).
  let payload: StatePayload | null;
  try { payload = await deps.store.take(hashState(input.state)); }
  catch { throw new OAuthError("store_unavailable", "Serviço temporariamente indisponível. Tente novamente."); }
  if (!payload) return fail("expired"); // inexistente, expirado ou já usado
  // 2) CSRF / login CSRF: o retorno só vale para o mesmo usuário que iniciou, e o papel é revalidado agora.
  if (payload.userId !== input.userId) return fail("forbidden");
  const orgId = payload.organizationId;
  if (!(await assertCanConnect(prisma, input.userId, orgId))) return fail("forbidden", orgId);

  // 3) cancelamento / erro devolvido pela Meta
  if (input.error) return fail(input.error === "access_denied" ? "cancelled" : "error", orgId);
  if (!input.code) return fail("error", orgId);

  const v = env.graphVersion;
  const secrets = [env.appSecret, input.code];
  let token: string;
  let expiresAt: Date | null = null;
  try {
    const q = new URLSearchParams({ client_id: env.appId, client_secret: env.appSecret, redirect_uri: env.redirectUri, code: input.code });
    const body = await graphGetJson(`https://graph.facebook.com/${v}/oauth/access_token?${q}`, secrets, deps.fetchImpl);
    if (typeof body?.access_token !== "string" || !body.access_token) return fail("error", orgId);
    token = body.access_token;
    if (Number(body.expires_in) > 0) expiresAt = new Date(Date.now() + Number(body.expires_in) * 1000);

    // 4) permissões realmente concedidas (o cliente pode desmarcar algumas no diálogo)
    const t = encodeURIComponent(token);
    const perms = await graphGetJson(`https://graph.facebook.com/${v}/me/permissions?access_token=${t}`, [...secrets, token], deps.fetchImpl).catch(() => null);
    const granted: string[] | null = perms ? (perms.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission)) : null;
    if (granted && granted.length && REQUIRED_PERMISSIONS.some((p) => !granted.includes(p))) return fail("insufficient_permissions", orgId);

    // 5) contas do Instagram atribuídas a este token
    const list = await graphGetJson(`https://graph.facebook.com/${v}/me/assigned_instagram_accounts?fields=id,username&limit=${MAX_ACCOUNTS}&access_token=${t}`, [...secrets, token], deps.fetchImpl);
    const accounts: { id: string; username: string }[] = (list.data ?? [])
      .filter((a: any) => a && typeof a.id === "string" && typeof a.username === "string").slice(0, MAX_ACCOUNTS);
    if (!accounts.length) return fail("no_accounts", orgId);

    const result: OAuthResult = { outcome: "connected", organizationId: orgId, connected: [], skipped: [] };
    for (const a of accounts) {
      // Conta que já existe NÃO tem o token substituído por este fluxo (preserva conexões atuais, ex.: @dabitech.br).
      const existing = await prisma.socialAccount.findUnique({ where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: a.id } } });
      if (existing) { result.skipped.push({ username: a.username, reason: existing.organizationId === orgId ? "already_connected" : "other_organization" }); continue; }
      try {
        const r = await connectInstagramAccount(
          { prisma, tokenEncryptionKey: env.tokenEncryptionKey, graphVersion: v, fetchImpl: deps.fetchImpl },
          { organizationId: orgId, providerAccountId: a.id, username: a.username, accessToken: token, loginMode: "FACEBOOK", scopes: granted?.length ? granted : [...REQUIRED_PERMISSIONS], expiresAt, actorUserId: input.userId },
        );
        result.connected.push({ id: r.id, username: r.username });
      } catch (e) {
        result.skipped.push({ username: a.username, reason: e instanceof ConnectError && e.code === "other_organization" ? "other_organization" : "error" });
      }
    }
    if (result.connected.length) result.outcome = result.skipped.length ? "partial" : "connected";
    else if (result.skipped.every((s) => s.reason === "already_connected")) result.outcome = "already_connected";
    else if (result.skipped.some((s) => s.reason === "other_organization")) result.outcome = "other_organization";
    else result.outcome = "error";
    return result;
  } catch (e) {
    // Código inválido/expirado/reutilizado, token rejeitado, falha de rede: mensagem da Meta já vem sem segredos.
    if (e instanceof MetaApiError) return fail("error", orgId);
    throw e;
  }
}
