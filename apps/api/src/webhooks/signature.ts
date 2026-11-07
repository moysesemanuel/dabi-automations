import { createHmac, timingSafeEqual } from "node:crypto";

/** Valida o header X-Hub-Signature-256 ("sha256=<hex>") sobre o corpo bruto. */
export function isValidMetaSignature(rawBody: Buffer | undefined, header: string | undefined, appSecret: string): boolean {
  if (!rawBody || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  let received: Buffer;
  try { received = Buffer.from(header.slice(7), "hex"); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected);
}
