import { UnrecoverableError } from "bullmq";

/**
 * Erro que sobe ao BullMQ. O BullMQ grava `failedReason` e `stacktrace` no Redis; mensagens livres de Prisma, zod
 * ou da rede podem conter valores do comentário (texto, autor). Por isso o que sai do worker é SEMPRE um destes
 * erros: mensagem curta e fixa (classe + código), sem valores, e pilha reduzida a uma linha (sem caminhos nem argumentos).
 */
export class SafeJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeJobError";
    this.stack = `SafeJobError: ${message}`;
    delete (this as { cause?: unknown }).cause;
  }
}

/** Código Prisma/driver que indica falha de infraestrutura passageira: o job pode ser repetido (nada foi reservado). */
const TRANSIENT_DB_CODES = new Set(["P1001", "P1002", "P1008", "P1017", "P2024", "P2034"]);

const token = (s: unknown) => String(s ?? "").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40);

/** Texto seguro para log/Redis: só classe e código, nunca a mensagem original. */
export function safeErrorText(e: unknown): string {
  if (e instanceof SafeJobError) return e.message;
  const name = token((e as { name?: unknown } | null)?.name) || "Error";
  const code = token((e as { code?: unknown } | null)?.code);
  return code ? `${name}:${code}` : name;
}

/** Falha de infraestrutura passageira (banco/rede). */
export function isTransientInfra(e: unknown): boolean {
  const code = String((e as { code?: unknown } | null)?.code ?? "");
  if (TRANSIENT_DB_CODES.has(code)) return true;
  const name = String((e as { name?: unknown } | null)?.name ?? "");
  return name === "TransientError" || name === "PrismaClientInitializationError";
}

/**
 * Converte QUALQUER erro em algo seguro de entregar ao BullMQ.
 * - já seguro → inalterado; `UnrecoverableError` (sem retry) também é reescrito sem a mensagem original;
 * - o resto → `SafeJobError` (o BullMQ repete até `attempts`; repetir é seguro: antes do claim nada foi reservado
 *   e, depois dele, a reexecução vê `attempts ≥ 1` e grava UNKNOWN sem chamar a Meta).
 */
export function toSafeJobError(e: unknown): Error {
  if (e instanceof SafeJobError) return e;
  if (e instanceof UnrecoverableError) {
    if (/^job_invalid:[A-Za-z0-9_]+$/.test(e.message)) return e; // motivo fixo, já seguro
    const u = new UnrecoverableError(`unrecoverable:${safeErrorText(e)}`);
    u.stack = `UnrecoverableError: ${u.message}`;
    return u;
  }
  return new SafeJobError(`${isTransientInfra(e) ? "transient" : "error"}:${safeErrorText(e)}`);
}

/** Job realmente inválido (formato): não adianta repetir. Motivo fixo, sem conteúdo. */
export function invalidJobError(reason: string): Error {
  const u = new UnrecoverableError(`job_invalid:${token(reason)}`);
  u.stack = `UnrecoverableError: ${u.message}`;
  return u;
}
