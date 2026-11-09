// Travas ESTRUTURAIS da premissa "sem registro de entrega, o DaBiChat não chamou a Meta": se alguém criar outro caminho de envio
// ou mover a chamada para antes da reserva, estes testes falham e obrigam a rever a redação de observabilidade.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(process.cwd(), "../..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === "node_modules" || n === "dist" ? [] : walk(p)) : [p]; });
const prod = (dir: string) => walk(join(ROOT, dir)).filter((f) => f.endsWith(".ts") && !/\.spec\.ts$|test-fixtures|test-infra|\.d\.ts$/.test(f));
const src = (f: string) => readFileSync(f, "utf8");

describe("caminhos de envio ao Meta (código de produção)", () => {
  const files = [...prod("apps/api/src"), ...prod("apps/worker/src")];

  it("só o worker (process-comment.ts) referencia os endpoints que enviam conteúdo a pessoas: /messages e /replies", () => {
    const hits = files.filter((f) => /\/messages|\/replies/.test(src(f))).map((f) => f.replace(ROOT + "/", ""));
    expect(hits).toEqual(["apps/worker/src/process-comment.ts"]);
  });

  it("a API não faz nenhuma requisição de ESCRITA a mensagens ou respostas (só leituras e a assinatura de webhook)", () => {
    for (const f of prod("apps/api/src")) expect(src(f), f).not.toMatch(/\/messages|\/replies/);
  });

  it("no worker, a reserva (create) vem ANTES da chamada de envio, tanto na DM quanto na resposta pública", () => {
    const code = src(join(ROOT, "apps/worker/src/process-comment.ts"));
    const dmCreate = code.indexOf("messageDelivery.create"), dmSend = code.indexOf("/messages`");
    const pubCreate = code.indexOf("publicReply.create"), pubSend = code.indexOf("/replies?");
    expect(dmCreate).toBeGreaterThan(-1); expect(dmSend).toBeGreaterThan(-1);
    expect(pubCreate).toBeGreaterThan(-1); expect(pubSend).toBeGreaterThan(-1);
    expect(dmCreate).toBeLessThan(dmSend);
    expect(pubCreate).toBeLessThan(pubSend);
  });

  it("existe um único ponto de chamada para cada endpoint de envio", () => {
    const code = src(join(ROOT, "apps/worker/src/process-comment.ts"));
    expect(code.split("/messages`").length - 1).toBe(1);
    expect(code.split("/replies?").length - 1).toBe(1);
  });
});
