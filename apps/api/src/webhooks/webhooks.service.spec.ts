import { describe, expect, it } from "vitest";
import { WebhooksService, commentJobId, resolveJobFormat } from "./webhooks.service";

const body = (id = "c1") => ({
  entry: [{ id: "ig1", changes: [{ field: "comments", value: { id, text: "LINK", media: { id: "m1" } } }] }],
});

type Opts = { queueFails?: boolean; accounts?: Record<string, any>; tombstones?: { commentId: string; expiresAt: Date }[]; format?: "legacy" | "minimal" };
const CONNECTED = { organizationId: "o1", disconnectedAt: null, credential: { id: "cr1" } };

function setup(existing?: { id: string; status: string; igAccountId?: string | null }, queueFailsOrOpts: boolean | Opts = false) {
  const o: Opts = typeof queueFailsOrOpts === "boolean" ? { queueFails: queueFailsOrOpts } : queueFailsOrOpts;
  const store: Record<string, any> = existing ? { "comment:c1": existing } : {};
  const added: any[] = [];
  const updates: any[] = [];
  const prisma: any = {
    automationEvent: {
      findUnique: async ({ where }: any) => store[where.providerEventKey] ?? null,
      create: async ({ data }: any) => (store[data.providerEventKey] = { id: "ev1", status: "RECEIVED", igAccountId: null, ...data }),
      update: async (a: any) => { updates.push(a); const e = Object.values(store).find((x: any) => x.id === a.where.id) as any; Object.assign(e, a.data); return e; },
    },
    socialAccount: { findUnique: async ({ where }: any) => (o.accounts ?? { ig1: CONNECTED })[where.provider_providerAccountId.providerAccountId] ?? null },
    idempotencyTombstone: { findUnique: async ({ where }: any) => (o.tombstones ?? []).find((t) => t.commentId === where.commentId) ?? null },
  };
  const svc: any = new WebhooksService(prisma, { format: o.format, now: () => new Date("2026-11-09T12:00:00Z") });
  svc._queue = { add: async (...a: any[]) => { if (o.queueFails) throw new Error("redis down"); added.push(a); } };
  return { svc: svc as WebhooksService, added, store, updates };
}

describe("WebhooksService.ingest: deduplicação visível", () => {
  it("evento já tratado: não reenfileira e registra no log (sem texto do comentário)", async () => {
    const { svc, added } = setup({ id: "ev1", status: "IGNORED" });
    const logs: string[] = [];
    (svc as any).logger = { debug: () => {}, log: (m: string) => logs.push(m), warn: () => {} };
    await svc.ingest(body("c1"));
    expect(added).toHaveLength(0);
    expect(logs.join(" ")).toMatch(/duplicado ignorado por deduplicação \(comment:c1, estado atual=IGNORED\)/);
    expect(logs.join(" ")).not.toContain("LINK"); // texto do comentário nunca vai ao log
  });
});

describe("WebhooksService.ingest: formatos do payload", () => {
  const unified = (cid: string) => ({ object: "instagram", entry: [{ id: "ig1", changes: [{ field: "comments", value: { comment_id: cid, text: "LINK", media: { id: "m1" }, from: { id: "u9" } } }] }] });
  it("Unified Login: usa value.comment_id (e o jobId/evento seguem esse id)", async () => {
    const { svc, added, store } = setup();
    await svc.ingest(unified("c77"));
    expect(added).toHaveLength(1);
    expect(added[0][1]).toMatchObject({ commentId: "c77", igAccountId: "ig1", mediaId: "m1", fromId: "u9" });
    expect(added[0][2].jobId).toBe("comment-c77");
    expect(store["comment:c77"]).toBeTruthy();
  });
  it("formato anterior (@dabitech.br): continua usando value.id", async () => {
    const { svc, added } = setup();
    await svc.ingest(body("c55"));
    expect(added[0][1]).toMatchObject({ commentId: "c55" });
  });
  it("se vierem os dois, prevalece comment_id", async () => {
    const { svc, added } = setup();
    await svc.ingest({ entry: [{ id: "ig1", changes: [{ field: "comments", value: { id: "velho", comment_id: "novo", text: "x", media: { id: "m1" } } }] }] });
    expect(added[0][1].commentId).toBe("novo");
  });
  it("sem nenhum id de comentário: ignora sem erro", async () => {
    const { svc, added } = setup();
    await svc.ingest({ entry: [{ id: "ig1", changes: [{ field: "comments", value: { text: "x" } }] }] });
    expect(added).toHaveLength(0);
  });
});

describe("WebhooksService.ingest", () => {
  it("jobId não contém ':' (limitação do BullMQ)", () => expect(commentJobId("123")).not.toContain(":"));

  it("evento novo: grava e enfileira com jobId válido", async () => {
    const { svc, added } = setup();
    await svc.ingest(body());
    expect(added).toHaveLength(1);
    expect(added[0][2].jobId).toBe("comment-c1");
  });

  it("se o Redis falhar, propaga o erro (a Meta reenvia) e o evento fica RECEIVED", async () => {
    const { svc, store } = setup(undefined, true);
    await expect(svc.ingest(body())).rejects.toThrow("redis down");
    expect(store["comment:c1"].status).toBe("RECEIVED");
  });

  it("reenvio de evento órfão (RECEIVED) tenta enfileirar de novo", async () => {
    const { svc, added } = setup({ id: "ev1", status: "RECEIVED" });
    await svc.ingest(body());
    expect(added).toHaveLength(1);
  });

  it("evento já processado não é reenfileirado", async () => {
    const { svc, added } = setup({ id: "ev1", status: "PROCESSED" });
    await svc.ingest(body());
    expect(added).toHaveLength(0);
  });
});

describe("WebhooksService.ingest: formato do job (E2)", () => {
  const SEGREDO = "TEXTO-SECRETO";
  const rico = (cid = "c1") => ({ object: "instagram", entry: [{ id: "ig1", changes: [{ field: "comments", value: { id: cid, text: SEGREDO, media: { id: "m1" }, from: { id: "u1", username: "usuario_secreto" } } }] }] });

  it("padrão (legacy): job idêntico ao de antes, mesmas opções de tentativa; igAccountId passa a ser gravado quando a conta é válida", async () => {
    const { svc, added, store } = setup();
    await svc.ingest(rico());
    expect(added).toHaveLength(1);
    expect(added[0][1]).toEqual({ eventId: "ev1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: SEGREDO, fromId: "u1" });
    expect(added[0][2]).toMatchObject({ jobId: "comment-c1", attempts: 3, backoff: { type: "exponential", delay: 2000 } });
    expect(store["comment:c1"].igAccountId).toBe("ig1");
  });

  it("jobs novos levam opções de retenção (24 h concluídos, 7 dias com falha)", async () => {
    const { svc, added } = setup();
    await svc.ingest(rico());
    expect(added[0][2].removeOnComplete).toEqual({ age: 86400, count: 1000 });
    expect(added[0][2].removeOnFail).toEqual({ age: 604800, count: 5000 });
  });

  it("valor inválido de COMMENT_JOB_FORMAT cai em legacy (nunca minimal por engano)", async () => {
    for (const v of [undefined, "", "MINIMAL", "min", "true", "legacy"]) expect(resolveJobFormat(v)).toBe("legacy");
    expect(resolveJobFormat("minimal")).toBe("minimal");
  });

  it("igAccountId só é gravado para conta conectada: desconhecida, sem credencial ou desconectada ficam nulos", async () => {
    for (const accounts of [{}, { ig1: { ...CONNECTED, credential: null } }, { ig1: { ...CONNECTED, disconnectedAt: new Date() } }, { ig1: { ...CONNECTED, organizationId: null } }]) {
      const { svc, store } = setup(undefined, { accounts });
      await svc.ingest(rico());
      expect(store["comment:c1"].igAccountId ?? null).toBeNull();
    }
  });

  it("minimal: o job é SÓ { eventId }, jobId interno, e nada do comentário aparece no job", async () => {
    const { svc, added } = setup(undefined, { format: "minimal" });
    await svc.ingest(rico());
    expect(added).toHaveLength(1);
    expect(added[0][1]).toEqual({ eventId: "ev1" });
    expect(added[0][2].jobId).toBe("evt-ev1");
    expect(added[0][2]).toMatchObject({ attempts: 3, backoff: { type: "exponential", delay: 2000 } });
    expect(JSON.stringify(added[0])).not.toMatch(new RegExp(`${SEGREDO}|usuario_secreto|c1|m1|ig1|u1`));
  });

  it("minimal + conta desconhecida: evento IGNORED na chegada, sem job e sem dado na fila", async () => {
    const { svc, added, store, updates } = setup(undefined, { format: "minimal", accounts: {} });
    await svc.ingest(rico());
    expect(added).toHaveLength(0);
    expect(store["comment:c1"].status).toBe("IGNORED");
    expect(updates[0].data).toEqual({ status: "IGNORED", error: "conta desconhecida" });
  });

  it("minimal + evento ANTERIOR à E2 reentregue (RECEIVED, sem igAccountId): job legado, e NÃO preenche igAccountId por inferência", async () => {
    const { svc, added, updates } = setup({ id: "ev1", status: "RECEIVED", igAccountId: null }, { format: "minimal" });
    await svc.ingest(rico());
    expect(added).toHaveLength(1);
    expect(added[0][1]).toMatchObject({ commentId: "c1", text: SEGREDO });
    expect(added[0][2].jobId).toBe("comment-c1");
    expect(updates).toHaveLength(0);
  });

  it("minimal + reentrega de evento já com igAccountId e ainda RECEIVED: reenfileira o mesmo job mínimo (mesmo jobId, sem duplicar)", async () => {
    const { svc, added } = setup({ id: "ev1", status: "RECEIVED", igAccountId: "ig1" }, { format: "minimal" });
    await svc.ingest(rico());
    await svc.ingest(rico());
    expect(added.map((a) => a[2].jobId)).toEqual(["evt-ev1", "evt-ev1"]); // o BullMQ ignora o jobId repetido enquanto o job existe
  });

  it("tombstone válido: não cria evento nem job (em qualquer formato); expirado não protege", async () => {
    for (const format of ["legacy", "minimal"] as const) {
      const { svc, added, store } = setup(undefined, { format, tombstones: [{ commentId: "c1", expiresAt: new Date("2026-11-09T12:00:01Z") }] });
      await svc.ingest(rico());
      expect(added).toHaveLength(0);
      expect(store["comment:c1"]).toBeUndefined();
    }
    const exp = setup(undefined, { tombstones: [{ commentId: "c1", expiresAt: new Date("2026-11-09T11:59:59Z") }] });
    await exp.svc.ingest(rico());
    expect(exp.added).toHaveLength(1);
  });

  it("tombstone não impede o reenvio de evento que ainda existe (a deduplicação de sempre continua valendo)", async () => {
    const { svc, added } = setup({ id: "ev1", status: "PROCESSED" }, { tombstones: [{ commentId: "c1", expiresAt: new Date("2027-01-01T00:00:00Z") }] });
    await svc.ingest(rico());
    expect(added).toHaveLength(0);
  });

  it("falha ao enfileirar continua propagando o erro (a Meta reenvia; o evento fica RECEIVED)", async () => {
    const { svc } = setup(undefined, { queueFails: true });
    await expect(svc.ingest(rico())).rejects.toThrow("redis down");
  });

  it("logs do serviço nunca contêm texto, autor ou token", async () => {
    const { svc } = setup(undefined, { format: "minimal", accounts: {} });
    const logs: string[] = [];
    (svc as any).logger = { debug: (m: string) => logs.push(m), log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
    await svc.ingest(rico());
    expect(logs.join("\n")).not.toMatch(new RegExp(`${SEGREDO}|usuario_secreto`));
  });
});

describe("WebhooksService.ingest: logs estruturados para operadores", () => {
  const rich = (cid = "c1") => ({ object: "instagram", entry: [{ id: "ig1", changes: [{ field: "comments", value: { id: cid, text: "TEXTO-SECRETO", from: { id: "u1", username: "usuario_secreto" }, media: { id: "m1" } } }] }] });
  const capture = (svc: any) => { const logs: string[] = []; svc.logger = { debug: (m: string) => logs.push(m), log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) }; return logs; };

  it("conta não reconhecida (minimal): log com ID interno do evento e código do motivo, sem texto nem autor", async () => {
    const { svc } = setup(undefined, { format: "minimal", accounts: {} }); const logs = capture(svc);
    await svc.ingest(rich());
    expect(logs.join("\n")).toMatch(/evento ignorado evento=ev1 motivo=ignored\.account_unknown/);
    expect(logs.join("\n")).not.toMatch(/TEXTO-SECRETO|usuario_secreto/);
  });
  it("duplicado: log com o ID interno do evento", async () => {
    const { svc } = setup({ id: "ev9", status: "IGNORED" }); const logs = capture(svc);
    await svc.ingest(rich());
    expect(logs.join("\n")).toMatch(/estado atual=IGNORED\) evento=ev9/);
  });
  it("tombstone: log com o código do motivo (não existe ID interno; só o ID do comentário)", async () => {
    const { svc } = setup(undefined, { tombstones: [{ commentId: "c1", expiresAt: new Date("2027-01-01T00:00:00Z") }] }); const logs = capture(svc);
    await svc.ingest(rich());
    expect(logs.join("\n")).toMatch(/motivo=dropped\.tombstone comentario=c1/);
    expect(logs.join("\n")).not.toMatch(/TEXTO-SECRETO|usuario_secreto/);
  });
});
