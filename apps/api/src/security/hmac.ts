import { createHmac, randomBytes } from "node:crypto";

/**
 * HMAC-SHA256 com chave secreta PRÓPRIA de cada finalidade. Nunca SHA-256 simples: um hash sem chave de e-mail ou IP
 * pode ser revertido por tentativa de correspondência (lista de e-mails/IPs conhecidos).
 *
 * - AUDIT_HMAC_KEY: identificador do e-mail em registros de auditoria (investigação de abuso).
 * - RATE_LIMIT_HMAC_KEY: chaves do limitador de tentativas no Redis (e-mail e IP).
 * As duas são independentes entre si e das chaves de autenticação (JWT) e de criptografia (tokens).
 */
export const HMAC_KEY_VERSION = "v1";

type KeyEnv = { NODE_ENV?: string; AUDIT_HMAC_KEY?: string; RATE_LIMIT_HMAC_KEY?: string };

const isProduction = (env: KeyEnv) => env.NODE_ENV === "production";
const normalize = (v: string) => v.trim().toLowerCase();
const digest = (key: string, purpose: string, value: string) => createHmac("sha256", key).update(`${purpose}:${normalize(value)}`).digest("hex");

/**
 * Metadados de auditoria para um e-mail digitado. Com chave: `{ emailHmac: "v1:<hex>" }`. Sem chave (só fora de
 * produção): `{}` — NENHUM identificador derivado do e-mail. Em produção sem chave: erro (fail-closed; a API já nem inicia).
 */
export function auditEmailMetadata(email: string, env: KeyEnv = process.env): { emailHmac?: string } {
  const key = env.AUDIT_HMAC_KEY;
  if (!key) {
    if (isProduction(env)) throw new Error("AUDIT_HMAC_KEY é obrigatória em produção");
    return {};
  }
  return { emailHmac: `${HMAC_KEY_VERSION}:${digest(key, "audit-email", email)}` };
}

let ephemeralKey: string | undefined;
let warnedEphemeral = false;

/**
 * Valor derivado (hex) para compor chaves do limitador. O limitador NUNCA fica desligado por falta de configuração:
 * fora de produção, sem RATE_LIMIT_HMAC_KEY, usa uma chave aleatória deste processo (os contadores deixam de valer
 * após reiniciar; só desenvolvimento) e avisa uma vez. Em produção, sem chave: erro.
 */
export function rateLimitDigest(purpose: "email" | "ip", value: string, env: KeyEnv = process.env, warn: (m: string) => void = () => {}): string {
  let key = env.RATE_LIMIT_HMAC_KEY;
  if (!key) {
    if (isProduction(env)) throw new Error("RATE_LIMIT_HMAC_KEY é obrigatória em produção");
    ephemeralKey ??= randomBytes(32).toString("hex");
    if (!warnedEphemeral) { warnedEphemeral = true; warn("RATE_LIMIT_HMAC_KEY ausente: usando chave temporária deste processo (apenas desenvolvimento)"); }
    key = ephemeralKey;
  }
  return digest(key, `rate-limit-${purpose}`, value).slice(0, 32);
}

/** Zera o estado interno (somente testes). */
export function _resetHmacStateForTests() { ephemeralKey = undefined; warnedEphemeral = false; }

/**
 * Validação de inicialização da API em produção: as duas chaves existem, têm tamanho mínimo e são independentes entre
 * si e do JWT_SECRET e do TOKEN_ENCRYPTION_KEY. Devolve a lista de problemas (vazia = ok).
 */
export function productionKeyProblems(env: KeyEnv & { JWT_SECRET?: string; TOKEN_ENCRYPTION_KEY?: string }): string[] {
  if (!isProduction(env)) return [];
  const p: string[] = [];
  const named: [string, string | undefined][] = [["AUDIT_HMAC_KEY", env.AUDIT_HMAC_KEY], ["RATE_LIMIT_HMAC_KEY", env.RATE_LIMIT_HMAC_KEY]];
  for (const [n, v] of named) {
    if (!v) p.push(`${n} é obrigatória em produção`);
    else if (v.length < 32) p.push(`${n} deve ter ao menos 32 caracteres`);
  }
  const all: [string, string | undefined][] = [...named, ["JWT_SECRET", env.JWT_SECRET], ["TOKEN_ENCRYPTION_KEY", env.TOKEN_ENCRYPTION_KEY]];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
    if (all[i][1] && all[i][1] === all[j][1]) p.push(`${all[i][0]} e ${all[j][0]} não podem ser iguais (devem ser independentes)`);
  return p;
}
