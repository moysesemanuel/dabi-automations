import { describe, it, expect } from "vitest";
import { EVENT_REASONS, deriveEventView, eventReasonFromNote, type DeliveryStatusValue } from "./index";

const ALL: DeliveryStatusValue[] = ["PENDING", "HELD", "SENT", "FAILED", "UNKNOWN", "CANCELED"];

describe("eventReasonFromNote", () => {
  it("reconhece códigos novos e os textos antigos já gravados", () => {
    expect(eventReasonFromNote("needs_review.ig_account_missing")).toBe("needs_review.ig_account_missing");
    expect(eventReasonFromNote("conta desconhecida")).toBe("ignored.account_unknown");
    expect(eventReasonFromNote("comentário da própria conta")).toBe("ignored.own_comment");
    expect(eventReasonFromNote("organização da automação difere da conta")).toBe("failed.org_mismatch");
  });
  it("notas DERIVADAS de entrega (formato antigo) e qualquer texto livre NÃO são razões de evento", () => {
    for (const n of ["entrega HELD: envio desabilitado (INSTAGRAM_SEND_ENABLED=false)", "entrega UNKNOWN: processo interrompido", "resposta pública SENT: x", "qualquer coisa", "", null, undefined, "__proto__", "toString"]) expect(eventReasonFromNote(n as any)).toBeNull();
  });
});

describe("deriveEventView: o estado vem da entrega real, nunca da nota do evento", () => {
  it("uma nota ANTIGA e contraditória no evento ('entrega UNKNOWN') é ignorada: a entrega SENT prevalece", () => {
    const v = deriveEventView({ status: "PROCESSED", error: "entrega UNKNOWN: processo interrompido durante o envio; resultado incerto" }, { status: "SENT" });
    expect(v.state).toBe("sent");
    expect(v.headline).toBe("Enviada");
    expect(JSON.stringify(v)).not.toMatch(/UNKNOWN|interrompido/);
  });
  it("cada estado de envio tem a sua apresentação", () => {
    const esperado: Record<DeliveryStatusValue, string> = { SENT: "sent", FAILED: "failed", UNKNOWN: "unknown", HELD: "held", CANCELED: "canceled", PENDING: "pending" };
    for (const s of ALL) expect(deriveEventView({ status: "PROCESSED" }, { status: s }).state).toBe(esperado[s]);
  });
  it("UNKNOWN nunca é apresentado como 'não enviada': diz que NÃO foi confirmado e que pode ter sido enviado", () => {
    const v = deriveEventView({ status: "PROCESSED" }, { status: "UNKNOWN" });
    expect(v.severity).toBe("attention");
    expect(v.headline).toMatch(/não confirmado/i);
    expect(v.detail).toMatch(/pode ter sido enviada/i);
    expect(v.detail).toMatch(/não reenvia/i);
    expect(`${v.headline} ${v.detail}`).not.toMatch(/não foi enviada|nada foi enviado|nenhuma mensagem foi enviada/i);
  });
  it("HELD diz que foi retido por segurança e que nada foi enviado; CANCELED não é confirmação da Meta", () => {
    const h = deriveEventView({ status: "RECEIVED" }, { status: "HELD" });
    expect(h.detail).toMatch(/retido.*segurança/i);
    expect(h.detail).toMatch(/Nada foi enviado/);
    expect(deriveEventView({ status: "PROCESSED" }, { status: "CANCELED" }).detail).toMatch(/não é uma confirmação da Meta/i);
  });
  it("razões de evento têm prioridade e distinguem needs_review, dropped e ignored", () => {
    expect(deriveEventView({ status: "RECEIVED", error: "needs_review.association_mismatch" }).state).toBe("needs_review");
    expect(deriveEventView({ status: "RECEIVED", error: "needs_review.association_mismatch" }).severity).toBe("attention");
    expect(deriveEventView({ status: "IGNORED", error: "dropped.tombstone" }).state).toBe("dropped");
    expect(deriveEventView({ status: "IGNORED", error: "conta desconhecida" }).state).toBe("ignored");
    expect(deriveEventView({ status: "FAILED", error: "organização da automação difere da conta" }).state).toBe("failed");
  });
  it("sem razão e sem entregas: recebido; com DM e resposta pública, a DM manda e a pública entra no detalhe", () => {
    expect(deriveEventView({ status: "RECEIVED" }).state).toBe("received");
    const v = deriveEventView({ status: "PROCESSED" }, { status: "SENT" }, { status: "UNKNOWN" });
    expect(v.state).toBe("sent");
    expect(v.detail).toMatch(/Resposta pública: resultado não confirmado/);
    expect(deriveEventView({ status: "PROCESSED" }, null, { status: "SENT" }).state).toBe("sent");
  });
  it("o catálogo não expõe texto nem dado do comentarista: só rótulos fixos", () => {
    for (const r of Object.values(EVENT_REASONS)) { expect(r.label.length).toBeGreaterThan(5); expect(`${r.label}${r.detail}`).not.toMatch(/\$\{|username|@/); }
  });
});

describe("needs_review: 'nada foi enviado' só com garantia", () => {
  const ev = { status: "RECEIVED", error: "needs_review.association_mismatch" };
  it("sem consulta às entregas: descrição conservadora, sem afirmar que nada foi enviado", () => {
    const v = deriveEventView(ev);
    expect(v.detail).toMatch(/Não foi possível garantir/);
    expect(v.detail).not.toMatch(/nada foi enviado/i);
  });
  it("consultou e NÃO há entrega nem resposta pública: pode afirmar (o registro precede qualquer chamada à Meta)", () => {
    const v = deriveEventView(ev, null, null, { noDeliveryRecords: true });
    expect(v.detail).toMatch(/Nenhuma entrega foi registrada/);
    expect(v.detail).toMatch(/nada foi enviado por ele/i);
  });
  it("há entrega registrada (mesmo HELD): descrição conservadora que manda conferir o histórico", () => {
    for (const s of ["HELD", "SENT", "UNKNOWN", "PENDING"] as const) {
      const v = deriveEventView(ev, { status: s }, null, { noDeliveryRecords: true });
      expect(v.detail).toMatch(/Já existe entrega registrada/);
      expect(v.detail).not.toMatch(/nada foi enviado por ele/i);
    }
  });
  it("a garantia nunca vale se a flag não for exatamente true", () => {
    for (const f of [undefined, false, 0 as any, "true" as any]) expect(deriveEventView(ev, null, null, { noDeliveryRecords: f }).detail).toMatch(/Não foi possível garantir/);
  });
  it("nenhuma razão do catálogo afirma 'nada foi enviado' por conta própria", () => {
    for (const r of Object.values(EVENT_REASONS)) expect(r.detail).not.toMatch(/nada foi enviado/i);
  });
});

describe("deriveEventView: IGNORED sem nota", () => {
  it("é 'nenhuma automação correspondente', não 'recebido'", () => {
    const v = deriveEventView({ status: "IGNORED", error: null });
    expect(v).toMatchObject({ state: "ignored", reason: "ignored.no_automation" });
  });
  it("uma nota explícita continua prevalecendo; evento RECEIVED sem nota continua 'recebido'", () => {
    expect(deriveEventView({ status: "IGNORED", error: "comentário da própria conta" }).reason).toBe("ignored.own_comment");
    expect(deriveEventView({ status: "RECEIVED", error: null }).state).toBe("received");
  });
});
