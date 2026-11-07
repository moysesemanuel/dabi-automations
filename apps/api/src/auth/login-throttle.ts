import { HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";
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

export const LOGIN_WINDOW_SEC = 15 * 60;
export const MAX_FAILURES_PER_EMAIL = 8;
export const MAX_FAILURES_PER_IP = 30;

/**
 * Limita tentativas de login erradas: por e-mail (proteção principal) e por IP (varreduras).
 * Chaves usam hash do e-mail (sem dado pessoal no Redis). Se o Redis estiver fora, o limitador
 * "abre" (não bloqueia ninguém) e registra um aviso: disponibilidade do login > limite temporário.
 */
@Injectable()
export class LoginThrottle {
  private logger = new Logger(LoginThrottle.name);
  /** Público para os testes trocarem o armazenamento. */
  store: CounterStore = new RedisCounterStore();

  private keys(ip: string | undefined, email: string) {
    const e = createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
    return { email: `rl:login:email:${e}`, ip: `rl:login:ip:${ip || "unknown"}` };
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try { return await fn(); } catch { this.logger.warn("limitador de login indisponível (Redis); seguindo sem limite"); return fallback; }
  }

  /** Lança 429 se o e-mail ou o IP já estourou o limite de falhas na janela. */
  async assertAllowed(ip: string | undefined, email: string) {
    const k = this.keys(ip, email);
    const [e, i] = await Promise.all([
      this.safe(() => this.store.peek(k.email), { count: 0, ttl: 0 }),
      this.safe(() => this.store.peek(k.ip), { count: 0, ttl: 0 }),
    ]);
    const blocked = e.count >= MAX_FAILURES_PER_EMAIL ? e : i.count >= MAX_FAILURES_PER_IP ? i : null;
    if (blocked) {
      const retryAfter = blocked.ttl || LOGIN_WINDOW_SEC;
      throw new HttpException({ message: "Muitas tentativas. Tente novamente em alguns minutos.", retryAfter }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async recordFailure(ip: string | undefined, email: string) {
    const k = this.keys(ip, email);
    await this.safe(async () => { await Promise.all([this.store.incr(k.email, LOGIN_WINDOW_SEC), this.store.incr(k.ip, LOGIN_WINDOW_SEC)]); }, undefined);
  }

  /** Login correto zera só o contador do e-mail (o do IP continua valendo contra varreduras). */
  async recordSuccess(_ip: string | undefined, email: string) {
    await this.safe(() => this.store.del(this.keys(undefined, email).email), undefined);
  }
}
