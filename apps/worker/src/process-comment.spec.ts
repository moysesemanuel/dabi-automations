import { describe, it, expect } from "vitest";
import { encryptToken } from "@dabi/config";
import { deriveEventView } from "@dabi/contracts";
import { processCommentEvent, resumePending, buildMessage, buildMessagePayload, type Deps } from "./process-comment";

const KEY = Buffer.alloc(32, 7).toString("base64");
const TOKEN = "EAAPRsecrettoken123";
const NOW = new Date("2026-11-07T12:00:00Z");
const isoAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString().replace("Z", "+0000");
const H = 3600_000;

// O fake entende `attempts` como número (igualdade) ou { gte: n }, como o Prisma.
const attemptsMatch = (actual: number, want: any) => want === undefined || (typeof want === "object" && want !== null ? (want.gte === undefined || actual >= want.gte) : actual === want);

function setup(opts: { credStatus?: string; publicEnabled?: boolean; auto?: Record<string, unknown>; sendEnabled?: boolean; resumeEnabled?: boolean; cred?: boolean; expired?: boolean; status?: string; orgMismatch?: boolean; existingDelivery?: any } = {}) {
  const enc = encryptToken(TOKEN, KEY);
  const account = {
    id: "acc1", organizationId: "org1", providerAccountId: "ig1",
    credential: opts.cred === false ? null : {
      encryptedToken: enc.encrypted, tokenIv: enc.iv, tokenTag: enc.tag, loginMode: "FACEBOOK",
      expiresAt: opts.expired ? new Date(NOW.getTime() - 1000) : null,
      status: opts.credStatus ?? "ACTIVE",
    },
  };
  const credUpdates: any[] = [];
  const automations = [{ id: "a1", organizationId: opts.orgMismatch ? "orgX" : "org1", keyword: "LINK", replyMessage: "Olá!", linkUrl: "https://dabitech.com.br", status: opts.status ?? "ACTIVE", ...(opts.auto ?? {}) }];
  const deliveries: any[] = opts.existingDelivery ? [{ id: "d0", organizationId: "org1", automationId: "a1", commentId: "c1", status: "PENDING", attempts: 0, ...opts.existingDelivery }] : [];
  const publicReplies: any[] = [];
  const events: Record<string, any> = { ev1: { id: "ev1", status: "RECEIVED", error: null } };
  const prisma = {
    socialAccount: { findUnique: async () => ({ ...account, credential: account.credential ? { ...account.credential } : null }) }, // snapshot, como o Prisma
    socialCredential: {
      updateMany: async ({ where, data }: any) => {
        credUpdates.push({ where, data });
        const c: any = account.credential;
        const hit = c && where.socialAccountId === account.id && c.status === where.status && c.encryptedToken === where.encryptedToken;
        if (hit) Object.assign(c, data);
        return { count: hit ? 1 : 0 };
      },
    },
    automation: { findMany: async ({ where }: any) => automations.filter((a) => a.status === where.status) },
    messageDelivery: {
      create: async ({ data }: any) => {
        if (deliveries.find((d) => d.commentId === data.commentId)) throw Object.assign(new Error("dup"), { code: "P2002" });
        const d = { id: `d${deliveries.length + 1}`, status: "PENDING", attempts: 0, ...data }; deliveries.push(d); return d;
      },
      findUnique: async ({ where }: any) => deliveries.find((d) => d.commentId === where.commentId) ?? null,
      findMany: async ({ where, take, cursor, skip }: any = {}) => {
        let l = deliveries.filter((d) => d.status === where?.status && d.attempts === 0).sort((a, b) => a.id.localeCompare(b.id));
        if (cursor) l = l.slice(l.findIndex((d) => d.id === cursor.id) + (skip ?? 0));
        return l.slice(0, take ?? l.length);
      },
      update: async ({ where, data }: any) => Object.assign(deliveries.find((d) => d.id === where.id)!, data),
      updateMany: async ({ where, data }: any) => {
        const d = deliveries.find((x) => x.id === where.id && x.status === where.status && attemptsMatch(x.attempts, where.attempts));
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
        const d = publicReplies.find((x) => x.id === where.id && x.status === where.status && attemptsMatch(x.attempts, where.attempts));
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
  return { deps, calls, deliveries, events, route, routePub, publicReplies, account, credUpdates };
}
const job = (over: Record<string, unknown> = {}) => ({ eventId: "ev1", igAccountId: "ig1", commentId: "c1", mediaId: "m1", text: "quero o link", fromId: "u9", ...over });
const ok = () => new Response(JSON.stringify({ recipient_id: "r1", message_id: "m_1" }), { status: 200 });

const tokenError = () => new Response(JSON.stringify({ error: { code: 190, type: "OAuthException", message: "Error validating access token: session invalidated" } }), { status: 400 });

const metaErr = (code: number, subcode?: number) => () => new Response(JSON.stringify({ error: { code, ...(subcode !== undefined ? { error_subcode: subcode } : {}), type: "OAuthException", message: "erro de teste" } }), { status: 400 });

// Regressão do classificador central nos TRÊS pontos de uso do worker (envio da DM, leitura da idade do comentário, resposta pública).
describe("classificador de erros da Meta nos pontos de uso do worker", () => {
  const credencialInvalida: [string, number, number | undefined][] = [["190 sem subcódigo", 190, undefined], ["190/458", 190, 458], ["190/460", 190, 460], ["190/463", 190, 463], ["190/467", 190, 467]];
  for (const [nome, code, sub] of credencialInvalida) {
    it(`${nome} no envio da DM: igual a antes (HELD, attempts 0, credencial marcada)`, async () => {
      const t = setup(); t.route(isoAgo(H), metaErr(code, sub));
      await processCommentEvent(t.deps, job());
      expect(t.deliveries[0]).toMatchObject({ status: "HELD", attempts: 0 });
      expect((t.account.credential as any).status).toBe("NEEDS_RECONNECT");
    });
  }

  for (const sub of [459, 464]) {
    it(`190/${sub} (ação do usuário no Facebook): NÃO marca a credencial; a entrega falha com o motivo, sem retry`, async () => {
      const t = setup(); t.route(isoAgo(H), metaErr(190, sub));
      await processCommentEvent(t.deps, job());
      expect((t.account.credential as any).status).toBe("ACTIVE");
      expect(t.credUpdates).toHaveLength(0);
      expect(t.deliveries[0].status).toBe("FAILED");
      expect(t.deliveries[0].error).toContain(`190/${sub}`);
      expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1); // uma só chamada: nada foi retentado
    });
  }

  it("200 SEM subcódigo (caso da elaniacosta.cake): NÃO marca a credencial; entrega FAILED com o código no motivo", async () => {
    const t = setup(); t.route(isoAgo(H), metaErr(200));
    await processCommentEvent(t.deps, job());
    expect((t.account.credential as any).status).toBe("ACTIVE");
    expect(t.credUpdates).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("FAILED");
    expect(t.deliveries[0].error).toMatch(/código 200/);
  });

  it("faixa 200–299 e código 10 (permissão): nunca derrubam a credencial", async () => {
    for (const code of [200, 210, 299, 10]) {
      const t = setup(); t.route(isoAgo(H), metaErr(code));
      await processCommentEvent(t.deps, job());
      expect((t.account.credential as any).status).toBe("ACTIVE");
      expect(t.deliveries[0].status).toBe("FAILED");
    }
  });

  it("leitura da idade do comentário com 190/463: retém e marca (igual a antes); com 190/459: não marca", async () => {
    const a = setup(); a.deps.fetchImpl = (async (u: any) => { a.calls.push({ url: String(u) }); return metaErr(190, 463)(); }) as any;
    await processCommentEvent(a.deps, job());
    expect(a.deliveries[0]).toMatchObject({ status: "HELD", attempts: 0 });
    expect((a.account.credential as any).status).toBe("NEEDS_RECONNECT");
    expect(a.calls.some((c) => c.url.includes("/messages"))).toBe(false);

    const b = setup(); b.deps.fetchImpl = (async (u: any) => { b.calls.push({ url: String(u) }); return metaErr(190, 459)(); }) as any;
    await processCommentEvent(b.deps, job());
    expect((b.account.credential as any).status).toBe("ACTIVE");
    expect(b.calls.some((c) => c.url.includes("/messages"))).toBe(false); // sem confirmar a idade, nada é enviado
    expect(b.deliveries[0].status).toBe("FAILED");
  });

  it("resposta pública: 190/463 marca a credencial (igual a antes); 200 e 190/459 não marcam", async () => {
    const opts = { publicEnabled: true, auto: { dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "Oi" } };
    const a = setup(opts); a.route(isoAgo(H), ok); a.routePub(metaErr(190, 463));
    await processCommentEvent(a.deps, job());
    expect(a.publicReplies[0].status).toBe("FAILED");
    expect((a.account.credential as any).status).toBe("NEEDS_RECONNECT");
    for (const [code, sub] of [[200, undefined], [190, 459]] as const) {
      const b = setup(opts); b.route(isoAgo(H), ok); b.routePub(metaErr(code, sub));
      await processCommentEvent(b.deps, job());
      expect(b.publicReplies[0].status).toBe("FAILED");
      expect((b.account.credential as any).status).toBe("ACTIVE");
    }
  });

  it("erro 5xx no envio continua UNKNOWN e sem retry (resultado ambíguo; paridade com o comportamento anterior)", async () => {
    const t = setup(); t.route(isoAgo(H), () => new Response("{}", { status: 502 }));
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("UNKNOWN");
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
  });
});

// P1: o estado de envio NÃO é copiado para o evento; o estado exibido é DERIVADO das entregas.
describe("evento sem notas derivadas do envio (P1)", () => {
  const view = (t: ReturnType<typeof setup>) => deriveEventView(t.events.ev1, t.deliveries[0], t.publicReplies[0]);

  it("envio desligado (HELD): evento RECEIVED sem nota; a visão derivada diz 'retida por segurança, nada enviado'", async () => {
    const t = setup({ sendEnabled: false }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.status).toBe("RECEIVED");
    expect(t.events.ev1.error ?? null).toBeNull();
    expect(view(t)).toMatchObject({ state: "held", severity: "attention" });
    expect(view(t).detail).toMatch(/Nada foi enviado/);
  });

  it("credencial a reconectar (HELD): evento sem nota; visão 'retida'", async () => {
    const t = setup({ credStatus: "NEEDS_RECONNECT" });
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.error ?? null).toBeNull();
    expect(view(t).state).toBe("held");
  });

  it("DM enviada: PROCESSED sem nota; visão 'enviada'", async () => {
    const t = setup(); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1).toMatchObject({ status: "PROCESSED", error: null });
    expect(view(t).state).toBe("sent");
  });

  it("DM rejeitada pela Meta (FAILED): PROCESSED sem nota; o motivo fica na entrega e a visão é 'falhou'", async () => {
    const t = setup(); t.route(isoAgo(H), () => new Response(JSON.stringify({ error: { code: 100, error_subcode: 2018, message: "x" } }), { status: 400 }));
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1).toMatchObject({ status: "PROCESSED", error: null });
    expect(t.deliveries[0].error).toContain("100/2018");
    expect(view(t).state).toBe("failed");
  });

  it("resultado incerto (UNKNOWN): PROCESSED sem nota e a visão NÃO diz 'não enviada'", async () => {
    const t = setup(); t.route(isoAgo(H), () => new Response("{}", { status: 502 }));
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1).toMatchObject({ status: "PROCESSED", error: null });
    const v = view(t);
    expect(v.state).toBe("unknown");
    expect(`${v.headline} ${v.detail}`).not.toMatch(/não foi enviada|nada foi enviado/i);
    expect(v.detail).toMatch(/pode ter sido enviada/i);
  });

  it("retomada desabilitada com entrega HELD preexistente: evento continua RECEIVED, sem nota", async () => {
    const t = setup({ existingDelivery: { status: "HELD", attempts: 0 }, resumeEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.events.ev1.error ?? null).toBeNull();
    expect(view(t).state).toBe("held");
  });

  it("razões de NÍVEL DE EVENTO continuam gravadas e são reconhecidas (comentário da própria conta)", async () => {
    const t = setup();
    await processCommentEvent(t.deps, job({ fromId: "ig1" }));
    expect(deriveEventView(t.events.ev1)).toMatchObject({ state: "ignored", reason: "ignored.own_comment" });
  });
});

describe("credencial inválida (erro 190)", () => {
  it("190 no envio: entrega fica HELD com attempts=0 (nada foi enviado), só a credencial desta conta é marcada", async () => {
    const t = setup(); t.route(isoAgo(H), tokenError);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0]).toMatchObject({ status: "HELD", attempts: 0 });
    expect(t.deliveries[0].error).toMatch(/reconecte/);
    expect(t.events.ev1.status).toBe("RECEIVED");
    expect((t.account.credential as any).status).toBe("NEEDS_RECONNECT");
    expect(t.credUpdates).toHaveLength(1);
    expect(t.credUpdates[0].where.socialAccountId).toBe("acc1");
    expect(JSON.stringify([t.deliveries, t.events, t.credUpdates])).not.toContain(TOKEN);
  });
  it("190 ao consultar a idade do comentário: também retém e marca, sem tentar enviar", async () => {
    const t = setup();
    t.deps.fetchImpl = (async (url: any) => { t.calls.push({ url: String(url) }); return tokenError(); }) as any;
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0]).toMatchObject({ status: "HELD", attempts: 0 });
    expect(t.calls.some((c) => c.url.includes("/messages"))).toBe(false);
    expect((t.account.credential as any).status).toBe("NEEDS_RECONNECT");
  });
  it("credencial já marcada: nenhuma chamada à Meta e a entrega é retida", async () => {
    const t = setup({ credStatus: "NEEDS_RECONNECT" });
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0]).toMatchObject({ status: "HELD", attempts: 0 });
    expect(t.deliveries[0].error).toMatch(/reconecte/);
  });
  it("não sobrescreve reconexão feita durante a chamada (filtro pelo token usado)", async () => {
    const t = setup(); t.route(isoAgo(H), async () => { (t.account.credential as any).encryptedToken = "TOKEN-NOVO"; return tokenError(); });
    await processCommentEvent(t.deps, job());
    expect((t.account.credential as any).status).toBe("ACTIVE"); // credencial nova continua ativa
    expect(t.deliveries[0].status).toBe("HELD");
  });
  it("resposta pública com 190: FAILED, credencial marcada; DM desabilitada", async () => {
    const t = setup({ publicEnabled: true, auto: { dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "Oi" } });
    t.route(isoAgo(H), ok); t.routePub(tokenError);
    await processCommentEvent(t.deps, job());
    expect(t.publicReplies[0].status).toBe("FAILED");
    expect((t.account.credential as any).status).toBe("NEEDS_RECONNECT");
  });
  it("resposta pública com credencial pendente: não chama a Meta", async () => {
    const t = setup({ credStatus: "NEEDS_RECONNECT", publicEnabled: true, auto: { dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "Oi" } });
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.publicReplies).toHaveLength(0);
  });
  it("após reconectar (credencial ACTIVE de novo) a entrega retida é liberada pela retomada e enviada", async () => {
    const t = setup({ existingDelivery: { status: "HELD", attempts: 0 } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
  });
});

describe("eventos ignorados ficam associados à conta", () => {
  it("sem automação correspondente: IGNORED com a conta e a organização gravadas, sem entrega nem chamada à Meta", async () => {
    const t = setup(); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job({ text: "nada a ver com a palavra-chave" }));
    expect(t.events.ev1).toMatchObject({ status: "IGNORED", socialAccountId: "acc1", organizationId: "org1" });
    expect(t.deliveries).toHaveLength(0);
    expect(t.calls).toHaveLength(0);
  });
  it("comentário da própria conta: IGNORED com a conta associada", async () => {
    const t = setup();
    await processCommentEvent(t.deps, job({ fromId: "ig1" }));
    expect(t.events.ev1).toMatchObject({ status: "IGNORED", error: "comentário da própria conta", socialAccountId: "acc1" });
  });
});

describe("processCommentEvent", () => {
  it("envio desabilitado: nenhuma chamada à Meta, entrega HELD e evento RECEIVED", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("HELD");
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
    t.route(isoAgo(H), () => new Response(JSON.stringify({ error: { message: `Token ${TOKEN} inválido`, type: "OAuthException", code: 100, error_subcode: 2018, fbtrace_id: "x" } }), { status: 400 }));
    await processCommentEvent(t.deps, job());
    const d = t.deliveries[0];
    expect(d.status).toBe("FAILED");
    expect(d.error).toContain("100/2018");
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
  it("entrega HELD NÃO sai por reentrega de webhook se a retomada está desligada", async () => {
    const t = setup({ sendEnabled: false, resumeEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("HELD");
    t.deps.env.sendEnabled = true; t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job()); // webhook reentregue
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("HELD");
  });

  it("retentativa normal de job (entrega PENDING, não retida) segue o fluxo", async () => {
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
  it("retoma entrega HELD quando o envio e a retomada são habilitados depois", async () => {
    const t = setup({ sendEnabled: false });
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("HELD");
    t.deps.env.sendEnabled = true; t.route(isoAgo(H), ok);
    expect(await resumePending(t.deps)).toMatchObject({ scanned: 1, resumed: 1, failed: 0 });
    expect(t.deliveries[0].status).toBe("SENT");
  });
});

describe("buildMessage", () => {
  it("sem link, só o texto", () => expect(buildMessage("Oi", null)).toBe("Oi"));
});

describe("estado HELD", () => {
  it("a mensagem de erro em texto NÃO controla nada: PENDING com o mesmo texto ainda segue o fluxo", async () => {
    const t = setup({ existingDelivery: { error: "envio desabilitado (INSTAGRAM_SEND_ENABLED=false)" }, resumeEnabled: false }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.deliveries[0].status).toBe("SENT");
  });
  it("HELD com envio e retomada ligados é liberada UMA vez e enviada", async () => {
    const t = setup({ existingDelivery: { status: "HELD" } }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    await processCommentEvent(t.deps, job());
    expect(t.calls.filter((c) => c.url.includes("/messages"))).toHaveLength(1);
    expect(t.deliveries[0].status).toBe("SENT");
  });
  it("HELD com retomada ligada mas envio global desligado continua retida", async () => {
    const t = setup({ existingDelivery: { status: "HELD" }, sendEnabled: false }); t.route(isoAgo(H), ok);
    await processCommentEvent(t.deps, job());
    expect(t.calls).toHaveLength(0);
    expect(t.deliveries[0].status).toBe("HELD");
  });
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
    expect(t.events.ev1.error).toBeNull(); // o evento não carrega nota de envio; o estado vem das entregas
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
