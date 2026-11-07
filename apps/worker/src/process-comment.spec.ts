import { describe, it, expect } from "vitest";
import { encryptToken } from "@dabi/config";
import { processCommentEvent, resumePending, buildMessage, type Deps } from "./process-comment";

const KEY = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "EAAPRsecrettoken123";
const NOW = new Date("2026-11-07T12:00:00Z");
const isoAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString().replace("Z", "+0000");
const H = 3600_000;

function setup(opts: { sendEnabled?: boolean; cred?: boolean; expired?: boolean; status?: string; orgMismatch?: boolean; existingDelivery?: any } = {}) {
  const enc = encryptToken(TOKEN, KEY);
  const account = {
    id: "acc1", organizationId: "org1", providerAccountId: "ig1",
    credential: opts.cred === false ? null : {
      encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK",
      expiresAt: opts.expired ? new Date(NOW.getTime() - 1000) : null,
    },
  };
  const automations = [{ id: "a1", organizationId: opts.orgMismatch ? "orgX" : "org1", keyword: "LINK", replyMessage: "Olá!", linkUrl: "https://dabitech.com.br", status: opts.status ?? "ACTIVE" }];
  const deliveries: any[] = opts.existingDelivery ? [{ id: "d0", organizationId: "org1", commentId: "c1", status: "PENDING", attempts: 0, ...opts.existingDelivery }] : [];
  const events: Record<string, any> = { ev1: { id: "ev1", status: "RECEIVED", error: null } };
  const prisma = {
    socialAccount: { findUnique: async () => account },
    automation: { findMany: async ({ where }: any) => automations.filter((a) => a.status === where.status) },
    messageDelivery: {
      create: async ({ data }: any) => {
        if (deliveries.find((d) => d.commentId === data.commentId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const d = { id: `d${deliveries.length + 1}`, status: "PENDING", attempts: 0, ...data }; deliveries.push(d); return d;
      },
      findUnique: async ({ where }: any) => deliveries.find((d) => d.commentId === where.commentId) ?? null,
      findMany: async () => deliveries.filter((d) => d.status === "PENDING" && d.attempts === 0),
      update: async ({ where, data }: any) => Object.assign(deliveries.find((d) => d.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const d = deliveries.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts);
        if (d) Object.assign(d, data);
        return { count: d ? 1 : 0 };
      },
    },
    automationEvent: {
      update: async ({ where, data }: any) => Object.assign(events[where.id], data),
      findUnique: async () => ({ id: "ev1", status: events.ev1.status, socialAccount: account, payload: { value: { media: { id: "m1" }, text: "LINK", from: { id: "u9" } } } }),
    },
  };
  const calls: { url: string; init?: any }[] = [];
  let handler: (url: string, init?: any) => Response | Promise<Response> = () => new Response("{}", { status: 200 });
  const deps: Deps = {
    prisma, now: () => NOW,
    env: { sendEnabled: opts.sendEnabled ?? true, graphVersion: "v23.0", encryptionKey: KEY },
    fetchImpl: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as any,
  };
  const route = (ts: string | null, send: () => Response | Promise<Response>) => {
    handler = (url) => (url.includes("/messages") ? send() : new Response(JSON.stringify(ts ? { timestamp: ts, id: "c1" } : {}), { status: 200 }));
  };
  return { deps, calls, deliveries, events, route };
}
const job = (over: Record<string, unknown> = {}) => ({ eventId: "ev1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: "quero o link", fromId: "u9", ...over });
const ok = () => new Response(JSON.stringify({ recipient_id: "r1", message_id: "m_1" }), { status: 200 });

describe("processCommentEvent", () => {
  it("envio desabilitado: nenhuma chamada à Meta, entrega PENDING e evento RECEIVED", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("PENDING");
    expect(t.events.ev1.status).toBe("RECEIVED");
  });

  it("sucesso: SENT com message_id, texto = mensagem + link, token só no header", async () => {
    const t = setup(); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0]).toMatchObject({ status: "SENT", attempts: 1, providerResponse: { message_id: "m_1" } });
    expect(t.events.ev1.status).toBe("PROCESSED");
    const send = t.calls.find((c) => c.url.includes("/messages"))!;
    expect(send.url).toBe("https://graph.facebook.com/v23.0/ig1/messages");
    expect(JSON.parse(send.init.body)).toEqual({ recipient: { comment_id: "c1" }, message: { text: "Olá! https://dabitech.com.br" } });
    expect(send.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(send.url).not.toContain(TOKEN);
  });

  it("comentário expirado (>7 dias): FAILED sem chamar /messages", async () => {
    const t = setup(); t.route(isoAgo(8 * 24 * H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("FAILED");
    expect(t.calls.some((c) => c.url.includes("/messages"))).toBe(false);
  });

  it("timestamp ausente: não envia", async () => {
    const t = setup(); t.route(null, ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("FAILED");
    expect(t.calls.some((c) => c.url.includes("/messages"))).toBe(false);
  });

  it("consulta do comentário com 5xx: repete o job, entrega segue PENDING", async () => {
    const t = setup(); t.route(isoAgo(H), ok);
    t.deps.fetchImpl = (async () => new Response("{}", { status: 503 })) as any;
    await expect(processCommentEvent(t.deps, job())).rejects.toThrow();
    expect(t.deliveries[0]).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("erro definitivo da Meta: FAILED com code/subcode, sem vazar o token", async () => {
    const t = setup();
    t.route(isoAgo(H), () => new Response(JSON.stringify({ error: { message: `Token ${TOKEN} inválido`, type: "OAuthException", code: 190, error_subcode: 463, fbtrace_id: "x" } }), { status: 400 }));
    await processCommentEvent(t.deps, job());
    const d = t.deliveries[0];
    expect(d.status).toBe("FAILED");
    expect(d.error).toContain("190/463");
    expect(JSON.stringify(d)).not.toContain(TOKEN);
    expect(JSON.stringify(t.events.ev1)).not.toContain(TOKEN);
  });

  it("timeout/erro de rede no envio: UNKNOWN", async () => {
    const t = setup(); t.route(isoAgo(H), () => { throw new Error("timeout"); });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("UNKNOWN");
    expect(t.events.ev1.status).toBe("PROCESSED");
  });

  it("HTTP 5xx no envio: UNKNOWN (não é falha comprovada)", async () => {
    const t = setup(); t.route(isoAgo(H), () => new Response("{}", { status: 502 }));
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("UNKNOWN");
  });

  it("webhook duplicado: segunda execução não envia de novo", async () => {
    const t = setup(); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    await processCommentEvent(t.deps, job());
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
  });

  it("PENDING com tentativa já registrada (queda no meio do envio): UNKNOWN, sem reenvio", async () => {
    const t = setup({ existingDelivery: { attempts: 1 } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("UNKNOWN");
    expect(t.calls).toHaveLength(0);
  });

  it("sem credencial / token expirado: FAILED sem chamada externa", async () => {
    for (const o of [{ cred: false }, { expired: true }]) {
      const t = setup(o);
      await processCommentEvent(t.deps, job());
      expect(t.deliveries[0].status).toBe("FAILED");
      expect(t.calls).toHaveLength(0);
    }
  });

  it("automação pausada: ignora e não reserva entrega", async () => {
    const t = setup({ status: "PAUSED" });
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.status).toBe("IGNORED");
    expect(t.deliveries).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });

  it("comentário da própria conta: ignora", async () => {
    const t = setup();
    await processCommentEvent(t.deps, job({ fromId: "ig1" }));
    expect(t.events.ev1.status).toBe("IGNORED");
    expect(t.deliveries).toHaveLength(0);
  });

  it("palavra-chave ausente: ignora", async () => {
    const t = setup();
    await processCommentEvent(t.deps, job({ text: "oi" }));
    expect(t.events.ev1.status).toBe("IGNORED");
  });

  it("organização da automação diferente da conta: bloqueia o envio", async () => {
    const t = setup({ orgMismatch: true });
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.status).toBe("FAILED");
    expect(t.deliveries).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });
});

describe("resumePending", () => {
  it("retoma entrega PENDING quando o envio é habilitado depois", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("PENDING");
    t.deps.env.sendEnabled = true; t.route(isoAgo(H), ok);
    expect(await resumePending(t.deps)).toBe(1);
    expect(t.deliveries[0].status).toBe("SENT");
  });
});

describe("buildMessage", () => {
  it("sem link, só o texto", () => expect(buildMessage("Oi", null)).toBe("Oi"));
});
