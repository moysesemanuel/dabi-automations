/**
 * Suporte dos testes de integração (PostgreSQL e Redis reais).
 *
 * - Locais: sem TEST_DATABASE_URL / TEST_REDIS_URL os testes de integração são PULADOS.
 * - CI (ou REQUIRE_INTEGRATION=1): a infraestrutura é OBRIGATÓRIA. Se faltar, um teste falha de propósito: um teste
 *   obrigatório nunca "passa" por ter sido pulado.
 * - Isolamento do Redis: o teste NUNCA usa a fila nem o prefixo de desenvolvimento ou produção. Fila `test-…`, prefixo
 *   próprio `bull-test-…`, banco lógico diferente do 0 (fora do CI) e limpeza só das chaves com esse prefixo.
 */
export const PG_URL = process.env.TEST_DATABASE_URL;
export const REDIS_URL = process.env.TEST_REDIS_URL;
export const REQUIRED = process.env.REQUIRE_INTEGRATION === "1" || process.env.CI === "true";

export const hasPg = Boolean(PG_URL);
export const hasRedis = Boolean(REDIS_URL);

/** Descreve por que o teste não pode rodar, ou null se pode. */
export function missingInfra(needs: { pg?: boolean; redis?: boolean }): string | null {
  const miss = [needs.pg && !hasPg ? "TEST_DATABASE_URL" : "", needs.redis && !hasRedis ? "TEST_REDIS_URL" : ""].filter(Boolean);
  return miss.length ? miss.join(" e ") : null;
}

/** Recusa qualquer alvo que possa ser o ambiente de desenvolvimento ou produção. */
export function assertIsolatedRedis(url: string, queueName: string, prefix: string) {
  const db = Number(new URL(url).pathname.replace("/", "") || "0");
  if (!queueName.startsWith("test-")) throw new Error(`fila de teste deve começar com "test-" (recebido: ${queueName})`);
  if (!prefix.startsWith("bull-test-")) throw new Error(`prefixo de teste deve começar com "bull-test-" (recebido: ${prefix})`);
  if (!process.env.CI && db === 0) throw new Error("TEST_REDIS_URL deve usar um banco lógico diferente do 0 (ex.: redis://localhost:6390/15) fora do CI");
}
