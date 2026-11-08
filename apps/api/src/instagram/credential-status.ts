import { MetaApiError } from "./graph";

/** Erro 190 da Meta = token inválido, revogado ou expirado. */
export const isInvalidTokenError = (e: unknown) => e instanceof MetaApiError && e.meta?.code === 190;

/**
 * Marca SÓ esta credencial como "precisa reconectar". Quando se informa o token usado, a marcação só vale se
 * ele ainda for o token atual (não derruba uma reconexão feita no meio da chamada). Idempotente.
 */
export async function markNeedsReconnect(prisma: any, input: { socialAccountId: string; encryptedToken?: string }, now: () => Date = () => new Date()) {
  await prisma.socialCredential.updateMany({
    where: { socialAccountId: input.socialAccountId, status: "ACTIVE", ...(input.encryptedToken ? { encryptedToken: input.encryptedToken } : {}) },
    data: { status: "NEEDS_RECONNECT", statusReason: "A Meta recusou o token (código 190)", statusChangedAt: now() },
  });
}
