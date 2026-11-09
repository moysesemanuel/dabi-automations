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

/**
 * Banco PostgreSQL DESCARTÁVEL próprio de um arquivo de teste: criado e migrado do zero (prisma migrate deploy) e removido no fim.
 * Isola o teste de tudo o que outros arquivos fazem em paralelo no banco de teste compartilhado. Exige TEST_DATABASE_URL com
 * permissão de CREATE DATABASE (no CI e no ambiente local de testes o usuário é dono do servidor descartável).
 */
export async function createDisposableDatabase(label: string): Promise<{ url: string; name: string; drop: () => Promise<void> }> {
  const { PrismaClient } = await import("@prisma/client");
  const { execFileSync } = await import("node:child_process");
  const { resolve } = await import("node:path");
  const base = new URL(PG_URL!);
  const name = `dabi_${label}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!/^dabi_[a-z0-9_]+$/.test(name)) throw new Error("nome de banco descartável inválido");
  const admin = new URL(base.toString()); admin.pathname = "/postgres";
  const ac = new PrismaClient({ datasourceUrl: admin.toString() });
  await ac.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  const target = new URL(base.toString()); target.pathname = `/${name}`;
  const url = target.toString();
  try {
    execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], { cwd: resolve(process.cwd(), "../../packages/database"), env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
  } catch (e) {
    await ac.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {}); await ac.$disconnect();
    throw new Error(`migração do banco descartável falhou: ${String((e as Error).message).split("\n")[0]}`);
  }
  return {
    url, name,
    drop: async () => { await ac.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await ac.$disconnect(); },
  };
}
