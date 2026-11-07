import { describe, it, expect } from "vitest";
import { encryptToken } from "@dabi/config";
import { processCommentEvent, resumePending, buildMessage, buildMessagePayload, type Deps } from "./process-comment";

const KEY = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "EAAPRsecrettoken123";
const NOW = new Date("2026-11-07T12:00:00Z");
const isoAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString().replace("Z", "+0000");
const H = 3600_000;

function setup(opts: { publicEnabled?: boolean; auto?: Record<string, unknown>; sendEnabled?: boolean; resumeEnabled?: boolean; cred?: boolean; expired?: boolean; status?: string; orgMismatch?: boolean; existingDelivery?: any } = {}) {
  const enc = encryptToken(TOKEN, KEY);
  const account = {
    id: "acc1", organizationId: "org1", providerAccountId: "ig1",
    credential: opts.cred === false ? null : {
      encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK",
      expiresAt: opts.expired ? new Date(NOW.getTime() - 1000) : null,
    },
  };
  const automations = [{ id: "a1", organizationId: opts.orgMismatch ? "orgX" : "org1", keyword: "LINK", replyMessage: "Olá!", linkUrl: "https://dabitech.com.br", status: opts.status ?? "ACTIVE", ...(opts.auto ?? {}) }];
  const deliveries: any[] = opts.existingDelivery ? [{ id: "d0", organizationId: "org1", automationId: "a1", commentId: "c1", status: "PENDING", attempts: 0, ...opts.existingDelivery }] : [];
  const publicReplies: any[] = [];
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
      findMany: async ({ take, cursor, skip }: any = {}) => {
        let l = deliveries.filter((d) => d.status === "PENDING" && d.attempts === 0).sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) l = l.slice(l.findIndex((d) => d.id === cursor.id) + (skip ?? 0));
        return l.slice(0, take ?? l.length);
      },
      update: async ({ where, data }: any) => Object.assign(deliveries.find((d) => d.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const d = deliveries.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts);
        if (d) Object.assign(d, data);
        return { count: d ? 1 : 0 };
      },
    },
    publicReply: {
      create: async ({ data }: any) => {
        if (publicReplies.find((d) => d.commentId === data.commentId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const d = { id: `p${publicReplies.length + 1}`, status: "PENDING", attempts: 0, error: null, ...data }; publicReplies.push(d); return d;
      },
      findUnique: async ({ where }: any) => publicReplies.find((d) => d.commentId === where.commentId) ?? null,
      update: async ({ where, data }: any) => Object.assign(publicReplies.find((d) => d.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const d = publicReplies.find((x) => x.id === where.id && x.status === where.status && x.attempts === where.attempts);
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
    env: { sendEnabled: opts.sendEnabled ?? true, resumeEnabled: opts.resumeEnabled ?? true, publicReplyEnabled: opts.publicEnabled ?? false, graphVersion: "v23.0", encryptionKey: KEY },
    fetchImpl: (async (url: any, init: any) => { calls.push({ url: String(url), init }); return handler(String(url), init); }) as any,
  };
  let t_pub: (() => Response | Promise<Response>) | undefined;
  const routePub = (h: () => Response | Promise<Response>) => { t_pub = h; };
  const route = (ts: string | null, send: () => Response | Promise<Response>) => {
    handler = (url) => (url.includes("/replies") ? (t_pub?.() ?? new Response(JSON.stringify({ id: "r_1" }), { status: 200 })) : url.includes("/messages") ? send() : new Response(JSON.stringify(ts ? { timestamp: ts, id: "c1" } : {}), { status: 200 }));
  };
  return { deps, calls, deliveries, events, route, routePub, publicReplies };
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

describe("retomada e integridade", () => {
  it("entrega nascida com envio desligado NÃO sai por reentrega de webhook se a retomada está desligada", async () => {
    const t = setup({ sendEnabled: false, resumeEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].error).toContain("envio desabilitado");
    t.deps.env.sendEnabled = true; t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job()); // webhook reentregue
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("PENDING");
  });

  it("retentativa normal de job (entrega PENDING sem a marca) segue o fluxo", async () => {
    const t = setup({ existingDelivery: { error: null } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
  });

  it("entrega existente de outra automação com o mesmo commentId: bloqueia", async () => {
    const t = setup({ existingDelivery: { automationId: "outra" } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.status).toBe("FAILED");
    expect(t.calls).toHaveLength(0);
  });

  it("rate limit (HTTP 429 / código 4): FAILED sinalizado, sem retry", async () => {
    const t = setup();
    t.route(isoAgo(H), () => new Response(JSON.stringify({ error: { message: "limit", code: 4 } }), { status: 429 }));
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("FAILED");
    expect(t.deliveries[0].error).toMatch(/^RATE LIMIT/);
    expect(t.deliveries[0].providerResponse.rateLimited).toBe(true);
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
  });

  it("resumePending relata o resultado e não engole erros", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    t.deps.env.sendEnabled = true;
    t.deps.fetchImpl = (async () => new Response("{}", { status: 503 })) as any; // consulta transitória falha
    const logs: string[] = []; t.deps.log = (m) => logs.push(m);
    const r = await resumePending(t.deps);
    expect(r).toMatchObject({ scanned: 1, resumed: 0, failed: 1 });
    expect(logs.join("\n")).toContain("retomada falhou");
  });
});

describe("resumePending", () => {
  it("retoma entrega PENDING quando o envio é habilitado depois", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("PENDING");
    t.deps.env.sendEnabled = true; t.route(isoAgo(H), ok);
    expect(await resumePending(t.deps)).toMatchObject({ scanned: 1, resumed: 1, failed: 0 });
    expect(t.deliveries[0].status).toBe("SENT");
  });
});

describe("buildMessage", () => {
  it("sem link, só o texto", () => expect(buildMessage("Oi", null)).toBe("Oi"));
});

describe("formato BUTTON", () => {
  it("monta generic template com botão web_url", () => {
    expect(buildMessagePayload({ replyFormat: "BUTTON", replyMessage: "Conheça", linkUrl: "https://dabitech.com.br", buttonTitle: "Ver site" })).toEqual({
      attachment: { type: "template", payload: { template_type: "generic", elements: [{ title: "Conheça", buttons: [{ type: "web_url", url: "https://dabitech.com.br", title: "Ver site" }] }] } },
    });
  });
  it("rótulo padrão quando não informado; TEXT segue como texto", () => {
    const p: any = buildMessagePayload({ replyFormat: "BUTTON", replyMessage: "x", linkUrl: "https://a.com" });
    expect(p.attachment.payload.elements[0].buttons[0].title).toBe("Acessar");
    expect(buildMessagePayload({ replyFormat: "TEXT", replyMessage: "Oi", linkUrl: "https://a.com" })).toEqual({ text: "Oi https://a.com" });
  });
  it("envia o template no corpo da chamada e conclui SENT", async () => {
    const t = setup({ auto: { replyFormat: "BUTTON", buttonTitle: "Ver site" } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    const send = t.calls.find((c) => c.url.includes("/messages"))!;
    const body = JSON.parse(send.init.body);
    expect(body.recipient).toEqual({ comment_id: "c1" });
    expect(body.message.attachment.payload.elements[0].buttons[0]).toEqual({ type: "web_url", url: "https://dabitech.com.br", title: "Ver site" });
    expect(t.deliveries[0].status).toBe("SENT");
  });
  it("automação BUTTON inválida (sem link ou título >80): FAILED sem chamar a Meta", async () => {
    for (const auto of [{ replyFormat: "BUTTON", linkUrl: null }, { replyFormat: "BUTTON", replyMessage: "x".repeat(81) }]) {
      const t = setup({ auto }); t.route(isoAgo(H), ok);
      await processCommentEvent(t.deps, job());
      expect(t.deliveries[0].status).toBe("FAILED");
      expect(t.calls).toHaveLength(0);
    }
  });
});

describe("resposta pública", () => {
  const PUB = { publicReplyEnabled: true, publicReplyMessage: "Prontinho! Te enviei o link no direct." };
  const replies = (t: any) => t.calls.filter((c: any) => c.url.includes("/replies"));

  it("DM SENT + flag ligada: publica no comentário certo, com Bearer e sem token na URL; guarda o id", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
    const r = replies(t);
    expect(r).toHaveLength(1);
    const u = new URL(r[0].url);
    expect(u.origin + u.pathname).toBe("https://graph.facebook.com/v23.0/c1/replies"); // id do COMENTÁRIO
    expect(u.searchParams.get("message")).toBe(PUB.publicReplyMessage);
    expect(r[0].init.method).toBe("POST");
    expect(r[0].init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r[0].url).not.toContain(TOKEN);
    expect(t.publicReplies[0]).toMatchObject({ status: "SENT", attempts: 1, providerResponse: { id: "r_1" } });
    expect(t.events.ev1).toMatchObject({ status: "PROCESSED", error: null });
  });

  it("ordem: a resposta pública só ocorre depois da DM", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    const order = t.calls.map((c) => (c.url.includes("/replies") ? "public" : c.url.includes("/messages") ? "dm" : "age"));
    expect(order).toEqual(["age", "dm", "public"]);
  });

  it("DM FAILED ou UNKNOWN: não publica a afirmação", async () => {
    for (const send of [() => new Response(JSON.stringify({ error: { code: 10, message: "x" } }), { status: 400 }), () => { throw new Error("timeout"); }]) {
      const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), send as any);
      await processCommentEvent(t.deps, job());
      expect(["FAILED", "UNKNOWN"]).toContain(t.deliveries[0].status);
      expect(replies(t)).toHaveLength(0);
      expect(t.publicReplies).toHaveLength(0);
    }
  });

  it("flag global desligada: DM segue, nenhuma chamada /replies e nenhuma linha criada", async () => {
    const t = setup({ auto: PUB, publicEnabled: false }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
    expect(replies(t)).toHaveLength(0);
    expect(t.publicReplies).toHaveLength(0);
    expect(t.events.ev1.error).toContain("INSTAGRAM_PUBLIC_REPLY_ENABLED=false");
  });

  it("automação sem resposta pública: nada é publicado mesmo com a flag ligada", async () => {
    const t = setup({ publicEnabled: true }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(replies(t)).toHaveLength(0);
  });

  it("DM desabilitada: resposta pública sai sozinha (sem /messages e sem MessageDelivery)", async () => {
    const t = setup({ auto: { ...PUB, dmEnabled: false }, publicEnabled: true, sendEnabled: false }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.calls.some((c) => c.url.includes("/messages"))).toBe(false);
    expect(t.deliveries).toHaveLength(0);
    expect(replies(t)).toHaveLength(1);
    expect(t.publicReplies[0].status).toBe("SENT");
  });

  it("DM habilitada e envio global desligado: não publica (DM não confirmada)", async () => {
    const t = setup({ auto: PUB, publicEnabled: true, sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.publicReplies).toHaveLength(0);
  });

  it("erro de permissão da Meta: FAILED com code/subcode, DM continua SENT, sem vazar token", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    t.routePub(() => new Response(JSON.stringify({ error: { message: `(#10) ${TOKEN} sem permissão`, type: "OAuthException", code: 10, error_subcode: 2108006, fbtrace_id: "ft" } }), { status: 403 }));
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
    const pr = t.publicReplies[0];
    expect(pr.status).toBe("FAILED");
    expect(pr.error).toContain("10/2108006");
    expect(pr.providerResponse).toMatchObject({ http: 403, code: 10, error_subcode: 2108006, fbtrace_id: "ft" });
    expect(JSON.stringify(pr)).not.toContain(TOKEN);
    expect(JSON.stringify(t.events.ev1)).not.toContain(TOKEN);
    expect(t.events.ev1.status).toBe("PROCESSED");
  });

  it("timeout e HTTP 5xx: UNKNOWN, sem retry", async () => {
    for (const h of [() => { throw new Error("timeout"); }, () => new Response("{}", { status: 502 }), () => new Response("{}", { status: 200 })]) {
      const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok); t.routePub(h as any);
      await processCommentEvent(t.deps, job());
      expect(t.publicReplies[0].status).toBe("UNKNOWN");
      expect(replies(t)).toHaveLength(1);
    }
  });

  it("webhook duplicado: segunda execução não publica de novo", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    await processCommentEvent(t.deps, job());
    expect(replies(t)).toHaveLength(1);
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
  });

  it("queda entre DM SENT e a publicação: a reentrega completa só a resposta pública (DM não repete)", async () => {
    const t = setup({ auto: PUB, publicEnabled: true, existingDelivery: { status: "SENT", attempts: 1 } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job()); // evento ainda RECEIVED
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(0);
    expect(replies(t)).toHaveLength(1);
    expect(t.publicReplies[0].status).toBe("SENT");
  });

  it("PENDING com tentativa registrada (queda durante a publicação): UNKNOWN, sem nova chamada", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    t.publicReplies.push({ id: "p0", organizationId: "org1", automationId: "a1", commentId: "c1", status: "PENDING", attempts: 1, error: null });
    await processCommentEvent(t.deps, job());
    expect(t.publicReplies[0].status).toBe("UNKNOWN");
    expect(replies(t)).toHaveLength(0);
  });

  it("resposta pública existente de outra automação: bloqueia", async () => {
    const t = setup({ auto: PUB, publicEnabled: true }); t.route(isoAgo(H), ok);
    t.publicReplies.push({ id: "p0", organizationId: "org1", automationId: "outra", commentId: "c1", status: "PENDING", attempts: 0, error: null });
    await processCommentEvent(t.deps, job());
    expect(replies(t)).toHaveLength(0);
    expect(t.publicReplies[0].status).toBe("PENDING");
  });

  it("comentário da própria conta: não responde nem publicamente", async () => {
    const t = setup({ auto: PUB, publicEnabled: true });
    await processCommentEvent(t.deps, job({ fromId: "ig1" }));
    expect(t.calls).toHaveLength(0);
    expect(t.publicReplies).toHaveLength(0);
  });

  it("sem credencial: FAILED sem chamada externa", async () => {
    const t = setup({ auto: { ...PUB, dmEnabled: false }, publicEnabled: true, cred: false });
    await processCommentEvent(t.deps, job());
    expect(t.publicReplies[0].status).toBe("FAILED");
    expect(t.calls).toHaveLength(0);
  });

  it("automação sem nenhuma ação habilitada: ignora", async () => {
    const t = setup({ auto: { dmEnabled: false, publicReplyEnabled: false }, publicEnabled: true });
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.status).toBe("IGNORED");
    expect(t.calls).toHaveLength(0);
  });
});
