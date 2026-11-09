/**
 * Trava de execução ÚNICA da retenção: arrendamento (lease) numa linha do PostgreSQL, com FENCING.
 *
 * Por que no banco e não só no Redis: a segurança dos dados precisa valer mesmo que um worker fique parado (pausa de GC, rede) e a
 * validade expire no meio de um lote. Uma trava Redis com TTL não garante isso sozinha. Aqui:
 *  - relógio único: tudo usa NOW() do banco (sem divergência de relógio entre workers);
 *  - aquisição só se a trava está livre ou EXPIRADA; cada aquisição incrementa o epoch (token de fencing);
 *  - renovação só pelo dono atual, com o mesmo epoch, e ainda válida (expirada, não renova: quem perdeu aborta);
 *  - liberação só pelo dono (verifica posse e epoch); nunca solta a trava de quem a tomou depois;
 *  - CADA lote confere posse e validade DENTRO da própria transação com SELECT … FOR SHARE: enquanto o lote roda, ninguém consegue
 *    tomar a trava (a tomada espera o fim do lote), e um lote que começou sem trava válida aborta sem alterar nada.
 * Não usa trava de sessão (pg_advisory_lock), então não precisa de conexão dedicada nem sofre com pool/queda de conexão: a queda do
 * worker apenas deixa a trava expirar.
 */
export const LEASE_ID = "retention";

export interface LeaseHandle { owner: string; epoch: number; id: string }
export class LeaseLostError extends Error { constructor() { super("trava de retenção perdida ou expirada"); this.name = "LeaseLostError"; } }

/** `id` identifica a trava; em produção é sempre LEASE_ID (singleton). Os testes usam ids próprios para não disputar a mesma linha. */
export async function acquireLease(prisma: any, owner: string, ttlSeconds: number, id: string = LEASE_ID): Promise<LeaseHandle | null> {
  await prisma.$executeRaw`INSERT INTO "RetentionLease" ("id", "epoch", "updatedAt") VALUES (${id}, 0, NOW()) ON CONFLICT ("id") DO NOTHING`;
  const rows: { epoch: number }[] = await prisma.$queryRaw`UPDATE "RetentionLease" SET "owner" = ${owner}, "epoch" = "epoch" + 1, "leaseUntil" = NOW() + make_interval(secs => ${ttlSeconds}), "heartbeatAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${id} AND ("leaseUntil" IS NULL OR "leaseUntil" < NOW()) RETURNING "epoch"`;
  return rows.length === 1 ? { owner, epoch: Number(rows[0].epoch), id } : null;
}

/** true = renovada. false = perdida/expirada: quem chama deve ABORTAR. */
export async function renewLease(prisma: any, h: LeaseHandle, ttlSeconds: number): Promise<boolean> {
  const n: number = await prisma.$executeRaw`UPDATE "RetentionLease" SET "leaseUntil" = NOW() + make_interval(secs => ${ttlSeconds}), "heartbeatAt" = NOW(), "updatedAt" = NOW() WHERE "id" = ${h.id} AND "owner" = ${h.owner} AND "epoch" = ${h.epoch} AND "leaseUntil" > NOW()`;
  return n === 1;
}

/** Libera SÓ se ainda for o dono, com o mesmo epoch. Devolve true se liberou. */
export async function releaseLease(prisma: any, h: LeaseHandle): Promise<boolean> {
  const n: number = await prisma.$executeRaw`UPDATE "RetentionLease" SET "owner" = NULL, "leaseUntil" = NULL, "updatedAt" = NOW() WHERE "id" = ${h.id} AND "owner" = ${h.owner} AND "epoch" = ${h.epoch}`;
  return n === 1;
}

/**
 * Fencing DENTRO da transação do lote: primeira instrução de todo lote. FOR SHARE segura a linha até o fim da transação, então a tomada
 * da trava espera o lote terminar. Se a posse ou a validade falharem, lança LeaseLostError e a transação é desfeita (nada é alterado).
 */
export async function assertLeaseInTx(tx: any, h: LeaseHandle): Promise<void> {
  const rows: unknown[] = await tx.$queryRaw`SELECT 1 AS ok FROM "RetentionLease" WHERE "id" = ${h.id} AND "owner" = ${h.owner} AND "epoch" = ${h.epoch} AND "leaseUntil" > NOW() FOR SHARE`;
  if (rows.length !== 1) throw new LeaseLostError();
}

/**
 * Renovação periódica em segundo plano. `onLost` é chamado se a renovação falhar (perdida, expirada ou erro de banco); o executor
 * então para antes do próximo lote. Não depende de Redis.
 */
export function startHeartbeat(prisma: any, h: LeaseHandle, ttlSeconds: number, onLost: (why: string) => void, everyMs = Math.max(250, (ttlSeconds * 1000) / 3)) {
  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped) return;
    try { if (!(await renewLease(prisma, h, ttlSeconds))) { stopped = true; clearInterval(timer); onLost("renovação recusada (perdida ou expirada)"); } }
    catch { stopped = true; clearInterval(timer); onLost("erro ao renovar a trava"); }
  }, everyMs);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
