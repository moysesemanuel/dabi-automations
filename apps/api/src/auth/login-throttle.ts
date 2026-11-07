import { HttpException, HttpStatus, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import { loadEnv } from "@dabi/config";

export interface CounterStore {
  /** Soma 1 ao contador (criando-o com validade na 1ª vez) e devolve o valor atual. */
  incr(key: string, windowSec: number): Promise<number>;
  /** Valor atual e segundos até expirar (0/0 se não existe). */
  peek(key: string): Promise<{ count: number; ttl: number }>;
  del(key: string): Promise<void>;
}

class RedisCounterStore implements CounterStore {
  private _redis?: Redis;
  private get redis() {
    // Falha rápida (sem fila offline): se o Redis cair, o login não trava; o limitador "abre" (ver abaixo).
    return (this._redis ??= new Redis(loadEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false, connectTimeout: 1000 }));
  }
  async incr(key: string, windowSec: number) {
    if (this.redis.status === "wait") await this.redis.connect().catch(() => {});
    const r = await this.redis.multi().incr(key).expire(key, windowSec, "NX").exec();
    return Number(r?.[0]?.[1] ?? 0);
  }
  async peek(key: string) {
    if (this.redis.status === "wait") await this.redis.connect().catch(() => {});
    const [count, ttl] = await Promise.all([this.redis.get(key), this.redis.ttl(key)]);
    return { count: Number(count ?? 0), ttl: Math.max(0, ttl) };
  }
  async del(key: string) { await this.redis.del(key); }
}

/** Contador em memória (por processo) usado quando o Redis está indisponível. Tamanho limitado e com expiração. */
export class LocalCounterStore implements CounterStore {
  private m = new Map<string, { count: number; expiresAt: number }>();
  constructor(private maxKeys = 10_000, private now: () => number = Date.now) {}
  private purge() {
    const t = this.now();
    for (const [k, v] of this.m) if (v.expiresAt <= t) this.m.delete(k);
    // Ainda cheio: descarta os mais antigos (ordem de inserção) para não crescer sem limite.
    while (this.m.size >= this.maxKeys) this.m.delete(this.m.keys().next().value as string);
  }
  async incr(key: string, windowSec: number) {
    const cur = this.m.get(key);
    if (cur && cur.expiresAt > this.now()) { cur.count++; return cur.count; }
    if (this.m.size >= this.maxKeys) this.purge();
    this.m.set(key, { count: 1, expiresAt: this.now() + windowSec * 1000 });
    return 1;
  }
  async peek(key: string) {
    const cur = this.m.get(key);
    if (!cur || cur.expiresAt <= this.now()) return { count: 0, ttl: 0 };
    return { count: cur.count, ttl: Math.ceil((cur.expiresAt - this.now()) / 1000) };
  }
  async del(key: string) { this.m.delete(key); }
  get size() { return this.m.size; }
}

export const LOGIN_WINDOW_SEC = 15 * 60;
export const MAX_FAILURES_PER_EMAIL = 8;
export const MAX_FAILURES_PER_IP = 30;

/**
 * Limita tentativas de login erradas: por e-mail (proteção principal) e por IP (varreduras).
 * Chaves usam hash do e-mail (sem dado pessoal no Redis).
 *
 * Contingência se o Redis cair (nunca desliga a proteção em silêncio):
 *  - "local" (padrão): passa a contar em memória neste processo, com os mesmos limites. Em várias
 *    instâncias o limite vira por instância (mais frouxo que o compartilhado), mas continua valendo.
 *  - "closed": o login responde 503 até o Redis voltar (LOGIN_THROTTLE_REDIS_DOWN=closed).
 * Toda queda gera aviso no log (no máximo 1 por minuto).
 */
@Injectable()
export class LoginThrottle {
  private logger = new Logger(LoginThrottle.name);
  /** Público para os testes trocarem o armazenamento. */
  store: CounterStore = new RedisCounterStore();
  local: CounterStore = new LocalCounterStore();
  /** Sobrescreve o modo (testes); senão vale LOGIN_THROTTLE_REDIS_DOWN. */
  mode?: "local" | "closed";
  private lastWarn = 0;

  private get failMode() { return this.mode ?? (process.env.LOGIN_THROTTLE_REDIS_DOWN === "closed" ? "closed" : "local"); }

  private keys(ip: string | undefined, email: string) {
    const e = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
    return { email: `rl:login:email:${e}`, ip: `rl:login:ip:${ip || "unknown"}` };
  }

  private warnDown() {
    if (Date.now() - this.lastWarn < 60_000) return;
    this.lastWarn = Date.now();
    this.logger.warn(`Redis indisponível para o limitador de login: modo "${this.failMode}"`);
  }

  /** Lança 429 se o e-mail ou o IP já estourou o limite de falhas na janela. */
  async assertAllowed(ip: string | undefined, email: string) {
    const k = this.keys(ip, email);
    let counters: { count: number; ttl: number }[];
    try {
      counters = await Promise.all([this.store.peek(k.email), this.store.peek(k.ip)]);
    } catch {
      this.warnDown();
      if (this.failMode === "closed") throw new ServiceUnavailableException("Login temporariamente indisponível. Tente novamente em instantes.");
      counters = await Promise.all([this.local.peek(k.email), this.local.peek(k.ip)]);
    }
    const [e, i] = counters;
    const blocked = e.count >= MAX_FAILURES_PER_EMAIL ? e : i.count >= MAX_FAILURES_PER_IP ? i : null;
    if (blocked) {
      const retryAfter = blocked.ttl || LOGIN_WINDOW_SEC;
      throw new HttpException({ message: "Muitas tentativas. Tente novamente em alguns minutos.", retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async recordFailure(ip: string | undefined, email: string) {
    const k = this.keys(ip, email);
    // O contador local é sempre alimentado: se o Redis cair logo depois, o histórico recente não se perde.
    await Promise.all([this.local.incr(k.email, LOGIN_WINDOW_SEC), this.local.incr(k.ip, LOGIN_WINDOW_SEC)]);
    try {
      await Promise.all([this.store.incr(k.email, LOGIN_WINDOW_SEC), this.store.incr(k.ip, LOGIN_WINDOW_SEC)]);
    } catch { this.warnDown(); }
  }

  /** Login correto zera só o contador do e-mail (o do IP continua valendo contra varreduras). */
  async recordSuccess(_ip: string | undefined, email: string) {
    const key = this.keys(undefined, email).email;
    await this.local.del(key);
    try { await this.store.del(key); } catch { this.warnDown(); }
  }
}
