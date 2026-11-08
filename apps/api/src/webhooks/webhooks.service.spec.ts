import { describe, expect, it } from "vitest";
import { WebhooksService, commentJobId } from "./webhooks.service";

const body = (id = "c1") => ({
  entry: [{ id: "ig1", changes: [{ field: "comments", value: { id, text: "LINK", media: { id: "m1" } } }] }],
});

function setup(existing?: { id: string; status: string }, queueFails = false) {
  const store: Record<string, any> = existing ? { "comment:c1": existing } : {};
  const added: any[] = [];
  const prisma: any = {
    automationEvent: {
      findUnique: async ({ where }: any) => store[where.providerEventKey] ?? null,
      create: async ({ data }: any) => (store[data.providerEventKey] = { id: "ev1", status: "RECEIVED", ...data }),
    },
  };
  const svc: any = new WebhooksService(prisma);
  svc._queue = { add: async (...a: any[]) => { if (queueFails) throw new Error("redis down"); added.push(a); } };
  return { svc: svc as WebhooksService, added, store };
}

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
