import { classifyMetaError, flagsCredentialForReconnect } from "@dabi/contracts";
import { MetaApiError } from "./graph";

/**
 * Credencial inválida segundo o classificador central: 190 com 458/460/463/467 ou sem subcódigo. NÃO inclui 190 com 459/464
 * (a pessoa precisa agir no Facebook) nem a faixa 200–299 (permissão).
 */
export const isInvalidTokenError = (e: unknown) =>
  e instanceof MetaApiError && flagsCredentialForReconnect(classifyMetaError({ http: e.meta?.http, code: e.meta?.code, subcode: e.meta?.subcode, operation: "read" }));

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
