import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { LedgerEntry, LedgerLike } from "./executor";

/**
 * Registro durável e INDEPENDENTE do banco operacional dos tombstones criados (e das partes excluídas) pela retenção. É a fonte para
 * RECONCILIAR depois de uma restauração de backup: um backup antigo não tem os tombstones criados depois dele, e só este registro sabe quais são.
 *
 * Formato: JSON por linha, append-only, com NÚMERO DE SEQUÊNCIA e CADEIA DE HASHES (cada linha inclui o hash da anterior). Qualquer
 * adulteração ou remoção no meio quebra a cadeia (verifyChain). O head (seq + hash) é também gravado em RetentionRun, o que permite ao
 * executor perceber que o banco está ATRÁS do registro (restauração) e recusar executar até reconciliar.
 *
 * Conteúdo: só IDs de comentário (identificador pseudonimizado), flags do que foi excluído, TTL, data e ID da execução. Nenhum texto,
 * username, token nem payload. Esta implementação em arquivo é para desenvolvimento e testes; a de produção deve usar armazenamento
 * externo com escrita só-anexar, imutável, criptografado e com retenção própria (decisão pendente).
 */
export interface LedgerLine { seq: number; at: string; phase: "intent" | "done"; runId: string; ttlSeconds: number; items: { commentId: string; event: boolean; records: boolean }[]; prev: string; hash: string }
const GENESIS = "0".repeat(64);
const digest = (prev: string, body: object) => createHash("sha256").update(prev + JSON.stringify(body)).digest("hex");

export class FileLedger implements LedgerLike {
  constructor(private path: string, private now: () => Date = () => new Date()) {}

  /** Lê todas as linhas e VERIFICA a cadeia. Lança se houver adulteração, remoção no meio ou número de sequência fora de ordem. */
  read(): LedgerLine[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LedgerLine);
    let prev = GENESIS; let seq = 0;
    for (const l of lines) {
      const { hash, ...body } = l;
      if (l.prev !== prev || l.seq !== seq + 1 || digest(prev, body) !== hash) throw new Error(`registro durável adulterado ou fora de ordem na linha ${seq + 1}`);
      prev = hash; seq = l.seq;
    }
    return lines;
  }

  async head() { const l = this.read(); const last = l[l.length - 1]; return last ? { seq: last.seq, hash: last.hash } : null; }

  private append(phase: "intent" | "done", e: LedgerEntry) {
    const lines = this.read(); const last = lines[lines.length - 1];
    const body = { seq: (last?.seq ?? 0) + 1, at: this.now().toISOString(), phase, runId: e.runId, ttlSeconds: e.ttlSeconds, items: e.items, prev: last?.hash ?? GENESIS };
    const line: LedgerLine = { ...body, hash: digest(body.prev, body) };
    mkdirSync(dirname(this.path), { recursive: true });
    const fd = openSync(this.path, "a", 0o600);
    try { writeSync(fd, JSON.stringify(line) + "\n"); fsyncSync(fd); } finally { closeSync(fd); } // durável: fsync antes de devolver
  }
  async intent(e: LedgerEntry) { this.append("intent", e); }
  async done(e: LedgerEntry) { this.append("done", e); }
}
