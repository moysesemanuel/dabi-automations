import { describe, it, expect } from "vitest";
import { DEFAULT_EXPIRY_LIMITS as L, canPurgeEvent, classifyDeliveryExpiry as c, type DeliveryState } from "./delivery-expiry";

const NOW = new Date("2026-11-09T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const MIN = 60_000, DAY = 86_400_000;
const row = (status: DeliveryState, attempts: number, age: number, created = age) => ({ status, attempts, updatedAt: ago(age), createdAt: ago(created) });

describe("PENDING presa (limite de 15 minutos)", () => {
  it("dentro do prazo, ou exatamente no limite: nada", () => {
    expect(c(row("PENDING", 0, 14 * MIN + 59_000), NOW)).toEqual({ kind: "none" });
    expect(c(row("PENDING", 0, 15 * MIN), NOW)).toEqual({ kind: "none" }); // "mais de 15 min": no limite ainda não expira
    expect(c(row("PENDING", 1, 15 * MIN), NOW)).toEqual({ kind: "none" });
  });
  it("attempts = 0 e mais de 15 min: CANCELA (a Meta nunca foi chamada)", () => {
    expect(c(row("PENDING", 0, 15 * MIN + 1), NOW).kind).toBe("cancel");
    expect(c(row("PENDING", 0, 3 * DAY), NOW).kind).toBe("cancel");
  });
  it("attempts ≥ 1 e mais de 15 min: UNKNOWN, NUNCA cancelada (pode ter chamado a Meta)", () => {
    for (const attempts of [1, 2, 5]) for (const age of [15 * MIN + 1, DAY, 40 * DAY]) {
      const a = c(row("PENDING", attempts, age), NOW);
      expect(a.kind).toBe("markUnknown");
      expect(a.kind).not.toBe("cancel");
    }
  });
});

describe("HELD (prazo máximo de 30 dias)", () => {
  it("até 30 dias (inclusive): nada; depois: cancela, pois nunca foi enviada", () => {
    expect(c(row("HELD", 0, 29 * DAY), NOW)).toEqual({ kind: "none" });
    expect(c(row("HELD", 0, 30 * DAY), NOW)).toEqual({ kind: "none" });
    expect(c(row("HELD", 0, 30 * DAY + 1), NOW).kind).toBe("cancel");
  });
  it("a idade conta desde a criação, não desde a última atualização", () => {
    expect(c({ status: "HELD", attempts: 0, createdAt: ago(31 * DAY), updatedAt: ago(1 * DAY) }, NOW).kind).toBe("cancel");
    expect(c({ status: "HELD", attempts: 0, createdAt: ago(1 * DAY), updatedAt: ago(31 * DAY) }, NOW).kind).toBe("none");
  });
  it("HELD com attempts ≥ 1 é anômala: NÃO afirma 'nunca enviada' (vira UNKNOWN)", () => {
    expect(c(row("HELD", 1, 31 * DAY), NOW).kind).toBe("markUnknown");
  });
});

describe("UNKNOWN: ausência de confirmação não prova que não foi enviada", () => {
  it("nunca é cancelada, em nenhuma idade", () => {
    for (const age of [0, 1 * DAY, 89 * DAY, 90 * DAY, 91 * DAY, 400 * DAY]) expect(c(row("UNKNOWN", 1, age), NOW).kind).not.toBe("cancel");
  });
  it("não é encerrada antes de 90 dias; depois, só o registro operacional é encerrado, EXIGINDO tombstone", () => {
    expect(c(row("UNKNOWN", 1, 90 * DAY), NOW)).toEqual({ kind: "none" });
    expect(c(row("UNKNOWN", 1, 90 * DAY + 1), NOW)).toEqual({ kind: "purge", requiresTombstone: true });
  });
});

describe("estados terminais (90 dias)", () => {
  it("SENT, FAILED e CANCELED: purge só depois de 90 dias e sempre com tombstone", () => {
    for (const st of ["SENT", "FAILED", "CANCELED"] as const) {
      expect(c(row(st, 1, 89 * DAY), NOW)).toEqual({ kind: "none" });
      expect(c(row(st, 1, 90 * DAY + 1), NOW)).toEqual({ kind: "purge", requiresTombstone: true });
    }
  });
  it("os limites são configuráveis e valem para todos os estados", () => {
    const lim = { pendingStuckMs: 1000, heldMaxAgeMs: 2000, recordMaxAgeMs: 3000 };
    expect(c(row("PENDING", 0, 1001), NOW, lim).kind).toBe("cancel");
    expect(c(row("HELD", 0, 2001), NOW, lim).kind).toBe("cancel");
    expect(c(row("SENT", 1, 3001), NOW, lim).kind).toBe("purge");
    expect(L).toEqual({ pendingStuckMs: 15 * MIN, heldMaxAgeMs: 30 * DAY, recordMaxAgeMs: 90 * DAY });
  });
});

describe("invariantes", () => {
  it("em TODA combinação de estado, tentativa e idade, 'cancel' só acontece se a Meta comprovadamente não foi chamada", () => {
    const estados: DeliveryState[] = ["PENDING", "HELD", "SENT", "FAILED", "UNKNOWN", "CANCELED"];
    for (const status of estados) for (const attempts of [0, 1, 2, 9]) for (const age of [0, 14 * MIN, 16 * MIN, 29 * DAY, 31 * DAY, 91 * DAY, 500 * DAY]) {
      const a = c(row(status, attempts, age), NOW);
      if (a.kind === "cancel") { expect(["PENDING", "HELD"]).toContain(status); expect(attempts).toBe(0); }
      if (status === "UNKNOWN") expect(a.kind).not.toBe("cancel");
      if (a.kind === "purge") expect(a.requiresTombstone).toBe(true);
    }
  });
});

describe("canPurgeEvent", () => {
  it("bloqueia enquanto houver entrega PENDING ou HELD; libera com as demais ou sem entregas", () => {
    expect(canPurgeEvent([])).toBe(true);
    expect(canPurgeEvent([{ status: "SENT" }, { status: "FAILED" }, { status: "UNKNOWN" }, { status: "CANCELED" }])).toBe(true);
    expect(canPurgeEvent([{ status: "SENT" }, { status: "HELD" }])).toBe(false);
    expect(canPurgeEvent([{ status: "PENDING" }])).toBe(false);
  });
});
