import { describe, it, expect, vi } from "vitest";
import { UnrecoverableError } from "bullmq";
import { handleCommentJob, jobFromEventPayload } from "./job-handler";
import { SafeJobError, safeErrorText, toSafeJobError } from "./safe-error";

const NOW = new Date("2026-11-09T12:00:00Z");
const SEGREDO = "TEXTO-SECRETO-DO-COMENTARISTA";
const USER = "usuario_secreto";

type Ev = { id: string; status: string; error: string | null; igAccountId: string | null; organizationId: string | null; socialAccountId: string | null; payload: any };
const payloadId = (over: any = {}) => ({ field: "comments", value: { id: "c1", text: SEGREDO, from: { id: "u1", username: USER }, media: { id: "m1" }, ...over } });

function fake(opts: { events?: Ev[]; accounts?: { id: string; organizationId: string; providerAccountId: string }[]; tombstones?: { commentId: string; expiresAt: Date }[] } = {}) {
  const events = new Map((opts.events ?? []).map((e) => [e.id, { ...e }]));
  const prisma = {
    automationEvent: {
      findUnique: vi.fn(async ({ where }: any) => events.get(where.id) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => { const e = events.get(where.id); if (!e || (where.status && e.status !== where.status)) return { count: 0 }; Object.assign(e, data); return { count: 1 }; }),
    },
    socialAccount: { findUnique: vi.fn(async ({ where }: any) => (opts.accounts ?? []).find((a) => a.providerAccountId === where.provider_providerAccountId.providerAccountId) ?? null) },
    idempotencyTombstone: { findUnique: vi.fn(async ({ where }: any) => (opts.tombstones ?? []).find((t) => t.commentId === where.commentId) ?? null) },
  };
  const logs: string[] = [];
  return { prisma, events, logs, deps: { prisma, now: () => NOW, log: (m: string) => logs.push(m), env: { sendEnabled: false, graphVersion: "v23.0", encryptionKey: "" } } as any };
}
const ev = (over: Partial<Ev> = {}): Ev => ({ id: "e1", status: "RECEIVED", error: null, igAccountId: "ig1", organizationId: null, socialAccountId: null, payload: payloadId(), ...over });
const acc = { id: "a1", organizationId: "o1", providerAccountId: "ig1" };

describe("handleCommentJob: formato mínimo", () => {
  it("evento ausente → dropped, sem processar e sem erro (não repete)", async () => {
    const f = fake(); const run = vi.fn();
    expect(await handleCommentJob(f.deps, { eventId: "nao-existe" }, run)).toEqual({ outcome: "dropped" });
    expect(run).not.toHaveBeenCalled();
  });

  it("evento já tratado (não RECEIVED) → dropped", async () => {
    for (const status of ["PROCESSED", "IGNORED", "FAILED"]) {
      const f = fake({ events: [ev({ status })], accounts: [acc] }); const run = vi.fn();
      expect(await handleCommentJob(f.deps, { eventId: "e1" }, run)).toEqual({ outcome: "dropped" });
      expect(run).not.toHaveBeenCalled();
    }
  });

  it("igAccountId ausente → needs_review: nada enviado e o evento NÃO vira estado terminal", async () => {
    const f = fake({ events: [ev({ igAccountId: null })], accounts: [acc] }); const run = vi.fn();
    expect(await handleCommentJob(f.deps, { eventId: "e1" }, run)).toEqual({ outcome: "needs_review" });
    expect(run).not.toHaveBeenCalled();
    expect(f.events.get("e1")!.status).toBe("RECEIVED");
    expect(f.events.get("e1")!.error).toBe("needs_review.ig_account_missing");
  });

  it("payload sem id do comentário → needs_review, nada enviado", async () => {
    const f = fake({ events: [ev({ payload: { field: "comments", value: { text: "x" } } })], accounts: [acc] }); const run = vi.fn();
    expect((await handleCommentJob(f.deps, { eventId: "e1" }, run)).outcome).toBe("needs_review");
    expect(run).not.toHaveBeenCalled();
    expect(f.events.get("e1")!.status).toBe("RECEIVED");
  });

  it("associação inconsistente (evento aponta para outra conta/organização) → needs_review, nada enviado", async () => {
    for (const over of [{ socialAccountId: "OUTRA" }, { organizationId: "OUTRA" }]) {
      const f = fake({ events: [ev(over)], accounts: [acc] }); const run = vi.fn();
      expect((await handleCommentJob(f.deps, { eventId: "e1" }, run)).outcome).toBe("needs_review");
      expect(run).not.toHaveBeenCalled();
      expect(f.events.get("e1")!.status).toBe("RECEIVED");
    }
  });

  it("associação já gravada e coerente → processa", async () => {
    const f = fake({ events: [ev({ socialAccountId: "a1", organizationId: "o1" })], accounts: [acc] }); const run = vi.fn(async () => ({ status: "PROCESSED" }));
    expect(await handleCommentJob(f.deps, { eventId: "e1" }, run)).toEqual({ outcome: "processed" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("conta desconhecida → segue para o processamento (que grava IGNORED, como no legado)", async () => {
    const f = fake({ events: [ev()], accounts: [] }); const run = vi.fn(async () => ({ status: "IGNORED" }));
    expect(await handleCommentJob(f.deps, { eventId: "e1" }, run)).toEqual({ outcome: "ignored" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("tombstone válido → dropped, evento duplicado vira IGNORED e nada é processado; expirado não protege", async () => {
    const f = fake({ events: [ev()], accounts: [acc], tombstones: [{ commentId: "c1", expiresAt: new Date(NOW.getTime() + 1000) }] }); const run = vi.fn();
    expect((await handleCommentJob(f.deps, { eventId: "e1" }, run)).outcome).toBe("dropped");
    expect(run).not.toHaveBeenCalled();
    expect(f.events.get("e1")!.status).toBe("IGNORED");

    const g = fake({ events: [ev()], accounts: [acc], tombstones: [{ commentId: "c1", expiresAt: new Date(NOW.getTime() - 1000) }] }); const run2 = vi.fn(async () => ({ status: "PROCESSED" }));
    expect((await handleCommentJob(g.deps, { eventId: "e1" }, run2)).outcome).toBe("processed");
    expect(run2).toHaveBeenCalledTimes(1);
  });

  it("o job reconstruído do banco é IGUAL ao job legado completo (value.id e value.comment_id; com e sem autor)", async () => {
    const casos: [any, any][] = [
      [payloadId(), { eventId: "e1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: SEGREDO, fromId: "u1" }],
      [{ field: "comments", value: { comment_id: "c9", id: "x", text: "oi", media: { id: "m2" } } }, { eventId: "e1", igAccountId: "ig1", commentId: "c9", mediaId: "m2", text: "oi", fromId: undefined }],
      [{ field: "comments", value: { id: "c3" } }, { eventId: "e1", igAccountId: "ig1", commentId: "c3", mediaId: "", text: "", fromId: undefined }],
    ];
    for (const [payload, esperado] of casos) {
      const f = fake({ events: [ev({ payload })], accounts: [acc] }); const run = vi.fn(async () => ({ status: "PROCESSED" }));
      await handleCommentJob(f.deps, { eventId: "e1" }, run);
      expect(run).toHaveBeenCalledWith(f.deps, esperado);
      expect(jobFromEventPayload("e1", "ig1", payload)).toEqual(esperado);
    }
  });
});

describe("handleCommentJob: resultado e erros sem dado pessoal", () => {
  it("devolve SÓ { outcome }, mesmo que o processamento devolva a linha inteira do evento", async () => {
    const f = fake({ events: [ev()], accounts: [acc] });
    const linha = { id: "e1", payload: payloadId(), status: "PROCESSED", error: `contém ${SEGREDO}` };
    const r = await handleCommentJob(f.deps, { eventId: "e1" }, async () => linha);
    expect(Object.keys(r)).toEqual(["outcome"]);
    expect(JSON.stringify(r)).not.toMatch(new RegExp(`${SEGREDO}|${USER}|payload`));
  });

  it("job com formato inválido → UnrecoverableError (sem repetir), sem o conteúdo na mensagem, sem chamar o processamento", async () => {
    const f = fake(); const run = vi.fn();
    const e: any = await handleCommentJob(f.deps, { eventId: "e1", text: SEGREDO }, run).catch((x) => x);
    expect(e).toBeInstanceOf(UnrecoverableError);
    expect(e.message).toBe("job_invalid:minimal_shape_invalid");
    expect(`${e.message}${e.stack}`).not.toContain(SEGREDO);
    expect(run).not.toHaveBeenCalled();
  });

  it("erro de banco (P1001) com mensagem que contém texto do comentário → erro transitório NORMALIZADO, sem o texto, sem pilha original", async () => {
    const f = fake({ events: [ev()], accounts: [acc] });
    const original: any = Object.assign(new Error(`Can't reach database; args: ${SEGREDO}`), { code: "P1001", name: "PrismaClientKnownRequestError" });
    const e: any = await handleCommentJob(f.deps, { eventId: "e1" }, async () => { throw original; }).catch((x) => x);
    expect(e).toBeInstanceOf(SafeJobError);
    expect(e.message).toBe("transient:PrismaClientKnownRequestError:P1001");
    expect(`${e.message}\n${e.stack}`).not.toContain(SEGREDO);
    expect(e.stack).toBe(`SafeJobError: ${e.message}`);
    expect(e.cause).toBeUndefined();
    expect(f.logs.join("\n")).not.toContain(SEGREDO);
  });

  it("erro qualquer → 'error:<classe>', nunca a mensagem; erro de validação do Prisma não vaza argumentos", async () => {
    const f = fake({ events: [ev()], accounts: [acc] });
    const val = Object.assign(new Error(`Invalid invocation: data: { text: "${SEGREDO}" }`), { name: "PrismaClientValidationError" });
    const e: any = await handleCommentJob(f.deps, { eventId: "e1" }, async () => { throw val; }).catch((x) => x);
    expect(e.message).toBe("error:PrismaClientValidationError");
    expect(`${e.message}${e.stack}`).not.toContain(SEGREDO);
  });

  it("os logs do handler só trazem o ID interno do evento e o desfecho", async () => {
    const f = fake({ events: [ev()], accounts: [acc] });
    await handleCommentJob(f.deps, { eventId: "e1" }, async () => ({ status: "PROCESSED" }));
    await handleCommentJob(f.deps, { eventId: "ausente" }, async () => ({}));
    const todos = f.logs.join("\n");
    expect(todos).toMatch(/job formato=minimo evento=e1 resultado=processed motivo=-/);
    expect(todos).toMatch(/job formato=minimo evento=ausente resultado=dropped motivo=event_missing/);
    expect(todos).not.toMatch(new RegExp(`${SEGREDO}|${USER}|c1|m1|ig1`));
  });
});

describe("handleCommentJob: formato legado continua igual", () => {
  const legacy = { eventId: "e1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: SEGREDO, fromId: "u1" };
  it("repassa o job ao processamento exatamente como veio e devolve só o desfecho", async () => {
    const f = fake({ events: [ev()], accounts: [acc] }); const run = vi.fn(async () => ({ id: "e1", status: "PROCESSED", payload: payloadId() }));
    const r = await handleCommentJob(f.deps, legacy, run);
    expect(run).toHaveBeenCalledWith(f.deps, legacy);
    expect(r).toEqual({ outcome: "processed" });
  });
  it("tombstone também protege jobs legados", async () => {
    const f = fake({ events: [ev()], accounts: [acc], tombstones: [{ commentId: "c1", expiresAt: new Date(NOW.getTime() + 1000) }] }); const run = vi.fn();
    expect((await handleCommentJob(f.deps, legacy, run)).outcome).toBe("dropped");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("safe-error", () => {
  it("safeErrorText devolve só classe e código, sanitizados", () => {
    expect(safeErrorText(Object.assign(new Error("segredo"), { name: "Prisma Client!!", code: "P20/24" }))).toBe("PrismaClient:P2024");
    expect(safeErrorText("texto solto com segredo")).toBe("Error");
    expect(safeErrorText(null)).toBe("Error");
  });
  it("toSafeJobError reescreve UnrecoverableError sem a mensagem original, mas preserva o motivo fixo de job inválido", () => {
    const u = toSafeJobError(new UnrecoverableError(`vazou ${SEGREDO}`));
    expect(u).toBeInstanceOf(UnrecoverableError);
    expect(`${u.message}${u.stack}`).not.toContain(SEGREDO);
    expect(toSafeJobError(new UnrecoverableError("job_invalid:legacy_shape_invalid")).message).toBe("job_invalid:legacy_shape_invalid");
  });
});
