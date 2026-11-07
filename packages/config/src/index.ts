import { z } from "zod";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().min(1),
  META_WEBHOOK_VERIFY_TOKEN: z.string().min(8),
  META_GRAPH_VERSION: z.string().default("v23.0"),
  TOKEN_ENCRYPTION_KEY: z.string().min(1),
  JWT_SECRET: z.string().min(16),
  API_PORT: z.coerce.number().default(3001),
  WEB_URL: z.string().default("http://localhost:3000"),
  // Registro público desligado por padrão; só o 1º usuário pode se cadastrar.
  // Envio real de respostas privadas. Desligado por padrão: o worker não chama a Meta.
  INSTAGRAM_SEND_ENABLED: z.enum(["true", "false"]).default("false"),
  // Resposta pública automática nos comentários. Desligada por padrão.
  INSTAGRAM_PUBLIC_REPLY_ENABLED: z.enum(["true", "false"]).default("false"),
  // Retomada de entregas PENDING antigas (exige também INSTAGRAM_SEND_ENABLED=true). Desligada por padrão.
  INSTAGRAM_RESUME_PENDING_ENABLED: z.enum(["true", "false"]).default("false"),
  ALLOW_REGISTRATION: z.enum(["true", "false"]).default("false"),
});
export type Env = z.infer<typeof schema>;
export const loadEnv = (source: NodeJS.ProcessEnv = process.env): Env => schema.parse(source);

/** AES-256-GCM. A chave (32 bytes, base64) vem do ambiente, nunca do banco. */
export function encryptToken(plain: string, keyB64: string) {
  const key = Buffer.from(keyB64, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY deve ter 32 bytes (base64)");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return { encrypted: enc.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") };
}

export function decryptToken(p: { encrypted: string; iv: string; tag: string }, keyB64: string) {
  const d = createDecipheriv("aes-256-gcm", Buffer.from(keyB64, "base64"), Buffer.from(p.iv, "base64"));
  d.setAuthTag(Buffer.from(p.tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(p.encrypted, "base64")), d.final()]).toString("utf8");
}
