import { encryptToken } from "@dabi/config";

export class ConnectError extends Error {}

export type LoginMode = "INSTAGRAM" | "FACEBOOK";

export interface ConnectInput {
  loginMode?: LoginMode; // padrão: INSTAGRAM
  organizationId: string;
  providerAccountId: string;
  username: string;
  accessToken: string;
  scopes?: string[];
  expiresAt?: Date | null;
  actorUserId?: string;
}

export interface ConnectDeps {
  prisma: any; // PrismaClient (ou PrismaService)
  tokenEncryptionKey: string;
  graphVersion: string;
  fetchImpl?: typeof fetch;
}

const DEFAULT_SCOPES = ["instagram_business_basic", "instagram_business_manage_comments"];

async function getJson(deps: ConnectDeps, token: string, url: string) {
  const f = deps.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(url, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new ConnectError("Não foi possível consultar a Meta (rede/timeout).");
  }
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    // A mensagem de erro da Meta não ecoa o token; mesmo assim, limpamos qualquer ocorrência dele.
    const raw = String(body?.error?.message ?? "sem detalhes").split(token).join("[token]").slice(0, 200);
    const code = body?.error?.code != null ? `, código ${body.error.code}` : "";
    throw new ConnectError(`Meta rejeitou o token (HTTP ${res.status}${code}): ${raw}`);
  }
  return body;
}

/**
 * Consulta a Meta com o token e devolve a identidade real da conta.
 * O token vai na query (formato documentado) e NUNCA entra em mensagens de erro ou logs.
 * INSTAGRAM: graph.instagram.com/me | FACEBOOK: graph.facebook.com/{id da conta}
 */
async function fetchIdentity(deps: ConnectDeps, token: string, mode: LoginMode, accountId: string) {
  const t = encodeURIComponent(token);
  const v = deps.graphVersion;
  const body =
    mode === "FACEBOOK"
      ? await getJson(deps, token, `https://graph.facebook.com/${v}/${encodeURIComponent(accountId)}?fields=id,username&access_token=${t}`)
      : await getJson(deps, token, `https://graph.instagram.com/${v}/me?fields=user_id,username&access_token=${t}`);
  const id = String(body.user_id ?? body.id ?? "");
  if (!id || typeof body.username !== "string") throw new ConnectError("Resposta inesperada da Meta.");
  return { id, username: body.username as string };
}

/** Permissões realmente concedidas ao token (modo FACEBOOK). Falha => usa o padrão. */
async function fetchGrantedScopes(deps: ConnectDeps, token: string): Promise<string[] | null> {
  try {
    const b = await getJson(deps, token, `https://graph.facebook.com/${deps.graphVersion}/me/permissions?access_token=${encodeURIComponent(token)}`);
    const granted = (b.data ?? []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
    return granted.length ? granted : null;
  } catch {
    return null;
  }
}

/** Conecta (ou reconecta) uma conta Instagram a uma organização, com token criptografado e auditoria. */
export async function connectInstagramAccount(deps: ConnectDeps, input: ConnectInput) {
  const { prisma } = deps;

  const org = await prisma.organization.findUnique({ where: { id: input.organizationId } });
  if (!org) throw new ConnectError("Organização não encontrada.");

  const mode: LoginMode = input.loginMode ?? "INSTAGRAM";
  const identity = await fetchIdentity(deps, input.accessToken, mode, input.providerAccountId);
  if (identity.id !== input.providerAccountId)
    throw new ConnectError("O token pertence a outra conta (id não confere).");
  if (identity.username.toLowerCase() !== input.username.replace(/^@/, "").toLowerCase())
    throw new ConnectError("O token pertence a outro username.");

  const enc = encryptToken(input.accessToken, deps.tokenEncryptionKey);
  const scopes =
    input.scopes?.length ? input.scopes
    : (mode === "FACEBOOK" ? await fetchGrantedScopes(deps, input.accessToken) : null) ?? DEFAULT_SCOPES;

  return prisma.$transaction(async (tx: any) => {
    const existing = await tx.socialAccount.findUnique({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: identity.id } },
    });
    // Uma conta Instagram só pode pertencer a uma organização: impede "roubo" entre clientes.
    if (existing && existing.organizationId !== input.organizationId)
      throw new ConnectError("Esta conta já está conectada a outra organização.");

    const account = await tx.socialAccount.upsert({
      where: { provider_providerAccountId: { provider: "INSTAGRAM", providerAccountId: identity.id } },
      create: { organizationId: input.organizationId, provider: "INSTAGRAM", providerAccountId: identity.id, username: identity.username },
      update: { username: identity.username },
    });
    const cred = { encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: mode, scopes, expiresAt: input.expiresAt ?? null };
    await tx.socialCredential.upsert({
      where: { socialAccountId: account.id },
      create: { socialAccountId: account.id, ...cred },
      update: cred,
    });
    await tx.auditLog.create({
      data: {
        organizationId: input.organizationId,
        userId: input.actorUserId,
        action: existing ? "social_account.reconnected" : "social_account.connected",
        entityType: "SocialAccount",
        entityId: account.id,
        metadata: { provider: "INSTAGRAM", loginMode: mode, username: identity.username, scopes }, // nunca o token
      },
    });
    return { id: account.id as string, username: identity.username, reconnected: Boolean(existing) };
  });
}
