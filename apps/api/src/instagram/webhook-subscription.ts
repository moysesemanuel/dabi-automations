import { decryptToken } from "@dabi/config";

/** Único campo assinado: comentários. (A Meta aplica ao conta os campos marcados no painel do app.) */
export const WEBHOOK_FIELDS = "comments";

export class SubscriptionError extends Error {
  constructor(readonly code: "not_found" | "disabled" | "no_credential", message: string) { super(message); }
}

export interface SubscriptionDeps {
  prisma: any;
  env: { tokenEncryptionKey: string; graphVersion: string; allowedAccounts: string };
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SubscriptionResult { status: "SUBSCRIBED" | "FAILED"; subscribedAt: Date | null; error: string | null }

/** "" = desligado; "*" = qualquer conta; senão, lista de IDs do Instagram (separados por vírgula). */
export function subscriptionAllowed(allowed: string, igAccountId: string): boolean {
  const v = allowed.trim();
  if (!v) return false;
  if (v === "*") return true;
  return v.split(",").map((x) => x.trim()).filter(Boolean).includes(igAccountId);
}

const redact = (s: unknown, secrets: string[]) => {
  let out = String(s ?? "");
  for (const sec of secrets) if (sec) out = out.split(sec).join("[oculto]");
  return out.slice(0, 200);
};

/**
 * Assina os webhooks de comentários de UMA conta: POST https://graph.facebook.com/{v}/{ig-id}/subscribed_apps
 * (Unified Login, token de usuário de sistema). Idempotente: repetir não muda o resultado.
 * Isolamento: a conta é buscada por id E organização; de outra organização => not_found.
 * Nunca é chamado automaticamente após o OAuth.
 */
export async function subscribeAccountWebhook(deps: SubscriptionDeps, input: { organizationId: string; accountId: string; actorUserId?: string }): Promise<SubscriptionResult> {
  const { prisma, env } = deps;
  const f = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => new Date());

  const account = await prisma.socialAccount.findFirst({ where: { id: input.accountId, organizationId: input.organizationId }, include: { credential: true } });
  if (!account) throw new SubscriptionError("not_found", "Conta não encontrada.");
  if (!subscriptionAllowed(env.allowedAccounts, account.providerAccountId))
    throw new SubscriptionError("disabled", "O recebimento de comentários ainda não foi liberado para esta conta neste ambiente.");
  if (!account.credential) throw new SubscriptionError("no_credential", "A conta não tem credencial. Conecte-a novamente.");

  let token: string;
  try {
    const c = account.credential;
    token = decryptToken({ encrypted: c.encryptedToken, iv: c.tokenIv, tag: c.tokenTag }, env.tokenEncryptionKey);
  } catch {
    throw new SubscriptionError("no_credential", "Não foi possível ler a credencial da conta. Conecte-a novamente.");
  }

  let status: "SUBSCRIBED" | "FAILED" = "FAILED";
  let error: string | null = null;
  try {
    const res = await f(`https://graph.facebook.com/${env.graphVersion}/${encodeURIComponent(account.providerAccountId)}/subscribed_apps`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ subscribed_fields: WEBHOOK_FIELDS }),
      signal: AbortSignal.timeout(15_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.ok && body?.success === true) status = "SUBSCRIBED";
    else error = `Meta rejeitou (HTTP ${res.status}${body?.error?.code != null ? `, código ${body.error.code}` : ""}): ${redact(body?.error?.message ?? "sem detalhes", [token])}`;
  } catch {
    error = "Não foi possível falar com a Meta (rede ou tempo esgotado). Tente novamente.";
  }

  const at = status === "SUBSCRIBED" ? now() : null;
  await prisma.socialAccount.updateMany({
    where: { id: account.id, organizationId: input.organizationId },
    data: { webhookStatus: status, webhookSubscribedAt: at ?? account.webhookSubscribedAt ?? null, webhookError: error },
  });
  await prisma.auditLog.create({
    data: {
      organizationId: input.organizationId, userId: input.actorUserId,
      action: status === "SUBSCRIBED" ? "social_account.webhook_subscribed" : "social_account.webhook_failed",
      entityType: "SocialAccount", entityId: account.id,
      metadata: { fields: WEBHOOK_FIELDS, ...(error ? { error } : {}) }, // nunca o token
    },
  });
  return { status, subscribedAt: at, error };
}
