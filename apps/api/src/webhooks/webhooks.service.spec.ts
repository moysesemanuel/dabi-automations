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
