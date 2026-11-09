import { describe, it, expect } from "vitest";
import { AUTHORIZED_LIMITS, RETENTION_DEFAULTS as L, planUnit, type RecordSnap, type UnitSnapshot } from "./rules";
import { REQUIRED_DRY_RUN_DAYS, confirmationFor, resolveRetentionPlan, type RetentionRuntimeConfig } from "./authorization";
import type { DeliveryState } from "../delivery-expiry";

const NOW = new Date("2026-11-09T12:00:00Z");
const DAY = 86_400_000, MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const rec = (status: DeliveryState, attempts: number, ageMs: number, createdMs = ageMs): RecordSnap => ({ status, attempts, createdAt: ago(createdMs), updatedAt: ago(ageMs) });
const ev = (ageMs: number, status = "PROCESSED", error: string | null = null) => ({ status, error, receivedAt: ago(ageMs) });
const unit = (o: Partial<UnitSnapshot>): UnitSnapshot => ({ commentId: "c1", ...o });
const kinds = (u: UnitSnapshot) => planUnit(u, NOW).map((a) => a.kind);

describe("planUnit: eventos", () => {
  it("até 30 dias: nada; depois, exclui só o evento (as entregas continuam barrando duplicidade pela unicidade)", () => {
    expect(kinds(unit({ event: ev(29 * DAY) }))).toEqual(["none"]);
    expect(planUnit(unit({ event: ev(31 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: true, records: false } }]);
    expect(planUnit(unit({ event: ev(31 * DAY, "IGNORED", "conta desconhecida") }), NOW)).toEqual([{ kind: "purge", parts: { event: true, records: false } }]);
  });
  it("evento antigo com entrega processável (PENDING/HELD) é ADIADO: nunca apaga o que ainda pode ser reprocessado", () => {
    expect(kinds(unit({ event: ev(40 * DAY), dm: rec("HELD", 0, 10 * DAY) }))).toEqual(["defer"]);
    expect(kinds(unit({ event: ev(40 * DAY), pub: rec("PENDING", 0, 1 * MIN) }))).toEqual(["defer"]);
  });
  it("evento antigo com entrega terminal e recente: exclui só o evento", () => {
    expect(planUnit(unit({ event: ev(40 * DAY), dm: rec("SENT", 1, 20 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: true, records: false } }]);
  });
});

describe("planUnit: estados presos primeiro (e exclusão só numa rodada posterior)", () => {
  it("PENDING attempts 0 > 15 min → CANCELED; attempts ≥ 1 → UNKNOWN (nunca CANCELED)", () => {
    expect(planUnit(unit({ dm: rec("PENDING", 0, 16 * MIN) }), NOW)).toMatchObject([{ kind: "transition", target: "dm", to: "CANCELED" }]);
    expect(planUnit(unit({ dm: rec("PENDING", 1, 16 * MIN) }), NOW)).toMatchObject([{ kind: "transition", target: "dm", to: "UNKNOWN" }]);
    expect(kinds(unit({ dm: rec("PENDING", 0, 14 * MIN) }))).toEqual(["defer"]);
  });
  it("HELD > 30 dias → CANCELED (a Meta nunca foi chamada); HELD com attempts ≥ 1 (anômala) → UNKNOWN", () => {
    expect(planUnit(unit({ dm: rec("HELD", 0, 31 * DAY, 31 * DAY) }), NOW)).toMatchObject([{ kind: "transition", to: "CANCELED" }]);
    expect(planUnit(unit({ dm: rec("HELD", 1, 31 * DAY, 31 * DAY) }), NOW)).toMatchObject([{ kind: "transition", to: "UNKNOWN" }]);
  });
  it("quando há transição, NÃO há exclusão na mesma rodada, mesmo com evento e registros antigos", () => {
    const a = planUnit(unit({ event: ev(200 * DAY), dm: rec("PENDING", 1, 100 * DAY), pub: rec("SENT", 1, 100 * DAY) }), NOW);
    expect(a.map((x) => x.kind)).toEqual(["transition"]);
  });
  it("as duas modalidades são avaliadas de forma independente", () => {
    const a = planUnit(unit({ dm: rec("PENDING", 0, 20 * MIN), pub: rec("PENDING", 1, 20 * MIN) }), NOW);
    expect(a).toMatchObject([{ target: "dm", to: "CANCELED" }, { target: "pub", to: "UNKNOWN" }]);
  });
});

describe("planUnit: registros (DM e resposta pública JUNTOS)", () => {
  it("exclui os dois só quando AMBOS são terminais e AMBOS têm mais de 90 dias", () => {
    expect(planUnit(unit({ dm: rec("SENT", 1, 91 * DAY), pub: rec("SENT", 1, 91 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: false, records: true } }]);
    expect(kinds(unit({ dm: rec("SENT", 1, 100 * DAY), pub: rec("SENT", 1, 80 * DAY) }))).toEqual(["none"]); // uma modalidade jamais sai sozinha
    expect(kinds(unit({ dm: rec("SENT", 1, 100 * DAY), pub: rec("PENDING", 0, 1 * MIN) }))).toEqual(["defer"]);
  });
  it("com só uma modalidade registrada, ela sozinha basta (a outra nunca existiu)", () => {
    expect(planUnit(unit({ pub: rec("FAILED", 1, 91 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: false, records: true } }]);
  });
  it("evento ainda RECEIVED (processável) adia a exclusão dos registros", () => {
    expect(kinds(unit({ event: ev(10 * DAY, "RECEIVED"), dm: rec("SENT", 1, 100 * DAY) }))).toEqual(["defer"]);
  });
  it("o evento só sai junto com os registros se ele próprio já passou de 30 dias", () => {
    expect(planUnit(unit({ event: ev(35 * DAY), dm: rec("SENT", 1, 100 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: true, records: true } }]);
    expect(planUnit(unit({ event: ev(5 * DAY), dm: rec("SENT", 1, 100 * DAY) }), NOW)).toEqual([{ kind: "purge", parts: { event: false, records: true } }]);
  });
  it("UNKNOWN com mais de 90 dias tem o registro encerrado (com tombstone), SEM jamais ser tratado como 'não enviada'", () => {
    const a = planUnit(unit({ dm: rec("UNKNOWN", 1, 91 * DAY) }), NOW);
    expect(a).toEqual([{ kind: "purge", parts: { event: false, records: true } }]);
    expect(planUnit(unit({ dm: rec("UNKNOWN", 1, 89 * DAY) }), NOW)[0].kind).toBe("none");
  });
});

describe("planUnit: needs_review (30 d de análise, 90 d de retenção, encerramento explícito antes da exclusão)", () => {
  const nr = (ageMs: number) => ev(ageMs, "RECEIVED", "needs_review.association_mismatch");
  it("até 30 dias: dentro da janela de análise, nada a fazer", () => expect(kinds(unit({ event: nr(10 * DAY) }))).toEqual(["none"]));
  it("de 30 a 90 dias: marcado como atrasado (só relatório) e NUNCA excluído", () => {
    expect(kinds(unit({ event: nr(35 * DAY) }))).toEqual(["overdue_review", "defer"]);
    expect(kinds(unit({ event: nr(89 * DAY) }))).toEqual(["overdue_review", "defer"]);
  });
  it("com 90 dias ou mais: primeiro ENCERRAMENTO explícito (não exclui na mesma rodada)", () => {
    expect(kinds(unit({ event: nr(90 * DAY) }))).toEqual(["close_review"]);
    expect(kinds(unit({ event: nr(500 * DAY) }))).toEqual(["close_review"]);
  });
  it("depois de encerrado (dropped.review_expired), o evento segue a regra comum e pode ser excluído", () => {
    expect(planUnit(unit({ event: ev(91 * DAY, "IGNORED", "dropped.review_expired") }), NOW)).toEqual([{ kind: "purge", parts: { event: true, records: false } }]);
  });
  it("needs_review não fica indefinidamente: toda idade leva a encerramento e depois a exclusão", () => {
    for (const d of [90, 120, 400]) expect(kinds(unit({ event: nr(d * DAY) }))).toEqual(["close_review"]);
  });
});

describe("invariantes (todas as combinações de estado, tentativas e idade)", () => {
  const states: DeliveryState[] = ["PENDING", "HELD", "SENT", "FAILED", "UNKNOWN", "CANCELED"];
  const ages = [0, 14 * MIN, 16 * MIN, 10 * DAY, 29 * DAY, 31 * DAY, 89 * DAY, 91 * DAY, 400 * DAY];
  it("nunca exclui nada processável (PENDING/HELD); transição para CANCELED só com a Meta comprovadamente não chamada; UNKNOWN nunca vira CANCELED", () => {
    for (const s of states) for (const att of [0, 1, 3]) for (const a of ages) for (const evAge of [null, 5 * DAY, 40 * DAY, 100 * DAY]) for (const evStatus of ["RECEIVED", "PROCESSED", "IGNORED"]) {
      const u = unit({ event: evAge === null ? undefined : ev(evAge, evStatus), dm: rec(s, att, a, a) });
      const actions = planUnit(u, NOW);
      for (const x of actions) {
        if (x.kind === "purge") { expect(["PENDING", "HELD"]).not.toContain(s); expect(evAge !== null && evStatus === "RECEIVED" && x.parts.records).toBe(false); }
        if (x.kind === "transition" && x.to === "CANCELED") { expect(["PENDING", "HELD"]).toContain(s); expect(att).toBe(0); }
        if (x.kind === "transition") expect(s).not.toBe("UNKNOWN");
      }
      if (s === "UNKNOWN") expect(actions.some((x) => x.kind === "transition")).toBe(false);
    }
  });
  it("exclusão de registros sempre leva as DUAS modalidades (parts.records), nunca uma só", () => {
    for (const x of planUnit(unit({ dm: rec("SENT", 1, 200 * DAY), pub: rec("UNKNOWN", 1, 200 * DAY) }), NOW)) if (x.kind === "purge") expect(x.parts.records).toBe(true);
  });
});

describe("autorização da execução", () => {
  const base = (o: Partial<RetentionRuntimeConfig> = {}): RetentionRuntimeConfig => ({ enabled: true, mode: "dry-run", appEnv: "development", dbName: "dabi", resumeEnabled: false, consecutiveDryRunDays: 0, ...o });
  const okExec = (o: Partial<RetentionRuntimeConfig> = {}) => base({ mode: "execute", maxRowsPerRun: 50, batchSize: 10, consecutiveDryRunDays: 7, confirm: confirmationFor("development", "dabi", NOW, 50), ...o });

  it("desabilitada por padrão: nada roda", () => {
    expect(resolveRetentionPlan(base({ enabled: false }), NOW)).toMatchObject({ ok: false, disabled: true });
  });
  it("dry-run é o padrão e não exige confirmação nem histórico", () => {
    expect(resolveRetentionPlan(base(), NOW)).toEqual({ ok: true, mode: "dry-run", batchSize: 10, maxRows: 100 });
    expect(resolveRetentionPlan(base({ mode: "dry-run", confirm: "qualquer" }), NOW)).toMatchObject({ ok: true, mode: "dry-run" });
  });
  it("execução real válida: ambiente, banco, data, teto, 7 dias de dry-run, retomada desligada", () => {
    expect(resolveRetentionPlan(okExec(), NOW)).toEqual({ ok: true, mode: "execute", batchSize: 10, maxRows: 50 });
  });
  it("a confirmação precisa bater com ambiente, banco, data UTC e teto; qualquer divergência recusa", () => {
    for (const bad of [confirmationFor("production", "dabi", NOW, 50), confirmationFor("development", "outro", NOW, 50), confirmationFor("development", "dabi", new Date("2026-11-08T12:00:00Z"), 50), confirmationFor("development", "dabi", NOW, 60), "", "ok"])
      expect(resolveRetentionPlan(okExec({ confirm: bad }), NOW)).toMatchObject({ ok: false });
    expect(resolveRetentionPlan(okExec({ confirm: undefined }), NOW)).toMatchObject({ ok: false });
  });
  it("sem teto de linhas explícito: recusa (não existe valor padrão na execução real)", () => {
    expect(resolveRetentionPlan(okExec({ maxRowsPerRun: undefined, confirm: "x" }), NOW)).toMatchObject({ ok: false });
  });
  it("limites acima dos autorizados no código são recusados (aumento exige autorização e mudança de código)", () => {
    expect(AUTHORIZED_LIMITS).toEqual({ batchMax: 10, runMaxRows: 100 });
    expect(resolveRetentionPlan(okExec({ batchSize: 11 }), NOW)).toMatchObject({ ok: false });
    expect(resolveRetentionPlan(okExec({ maxRowsPerRun: 101, confirm: confirmationFor("development", "dabi", NOW, 101) }), NOW)).toMatchObject({ ok: false });
    expect(resolveRetentionPlan(base({ batchSize: 500 }), NOW)).toMatchObject({ ok: true, batchSize: 10 }); // no dry-run o lote é limitado, não recusado
  });
  it("bloqueia a execução real com a retomada de HELD habilitada", () => {
    const r = resolveRetentionPlan(okExec({ resumeEnabled: true }), NOW);
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).toMatch(/retomada de HELD/);
  });
  it("exige 7 dias CONSECUTIVOS de dry-run antes da primeira execução real", () => {
    expect(REQUIRED_DRY_RUN_DAYS).toBe(7);
    for (const d of [0, 3, 6]) expect(resolveRetentionPlan(okExec({ consecutiveDryRunDays: d }), NOW)).toMatchObject({ ok: false });
    expect(resolveRetentionPlan(okExec({ consecutiveDryRunDays: 7 }), NOW)).toMatchObject({ ok: true });
  });
  it("reporta TODOS os problemas de uma vez", () => {
    const r: any = resolveRetentionPlan(base({ mode: "execute", resumeEnabled: true }), NOW);
    expect(r.ok).toBe(false);
    expect(r.problems.length).toBeGreaterThanOrEqual(3);
  });
});

it("os padrões de retenção refletem as decisões aprovadas", () => {
  expect(L.eventMaxAgeMs).toBe(30 * DAY); expect(L.recordMaxAgeMs).toBe(90 * DAY); expect(L.tombstoneTtlSeconds).toBe(180 * 86400);
  expect(L.needsReviewAnalysisMs).toBe(30 * DAY); expect(L.needsReviewMaxMs).toBe(90 * DAY); expect(L.retentionRunMs).toBe(365 * DAY);
});
