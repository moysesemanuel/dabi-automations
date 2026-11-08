/**
 * `Secure` quando em produção OU quando o visitante chegou por HTTPS (ex.: túnel/proxy de desenvolvimento
 * que termina o TLS e repassa X-Forwarded-Proto). O Next atrás do túnel enxerga HTTP puro; sem isto o
 * cookie de sessão sairia sem Secure em ambiente HTTPS. Em http://localhost continua sem Secure.
 */
export function shouldUseSecureCookie(nodeEnv: string | undefined, forwardedProto: string | null | undefined): boolean {
  if (nodeEnv === "production") return true;
  return (forwardedProto ?? "").split(",")[0].trim().toLowerCase() === "https";
}
