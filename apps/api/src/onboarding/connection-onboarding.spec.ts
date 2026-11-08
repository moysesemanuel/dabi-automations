import { describe, expect, it } from "vitest";
import { updateConnectionOnboardingSchema } from "@dabi/contracts";
import { ConnectionOnboardingService } from "./connection-onboarding.service";

function fake() {
  const rows = new Map<string, any>();
  const prisma: any = {
    connectionOnboarding: {
      findUnique: async ({ where }: any) => rows.get(where.organizationId) ?? null,
      upsert: async ({ where, create, update }: any) => {
        const cur = rows.get(where.organizationId);
        const next = cur ? { ...cur, ...update } : { ...create };
        rows.set(where.organizationId, next);
        return next;
      },
    },
  };
  return { svc: new ConnectionOnboardingService(prisma), rows };
}

describe("ConnectionOnboardingService", () => {
  it("sem registro devolve o estado inicial", async () => {
    expect(await fake().svc.get("orgA")).toEqual({ step: "PREPARE", professionalAccount: null, businessPortfolio: null, instagramInPortfolio: null, lastOutcome: null });
  });
  it("guarda progresso e permite retomar", async () => {
    const { svc } = fake();
    await svc.update("orgA", "u1", { professionalAccount: "YES", businessPortfolio: "NO" });
    await svc.update("orgA", "u1", { step: "CONNECT" });
    expect(await svc.get("orgA")).toMatchObject({ step: "CONNECT", professionalAccount: "YES", businessPortfolio: "NO", instagramInPortfolio: null });
  });
  it("isolamento: o progresso de uma organização não aparece em outra", async () => {
    const { svc, rows } = fake();
    await svc.update("orgA", "u1", { businessPortfolio: "YES" });
    expect((await svc.get("orgB")).businessPortfolio).toBeNull();
    await svc.update("orgB", "u2", { businessPortfolio: "NO" });
    expect((await svc.get("orgA")).businessPortfolio).toBe("YES");
    expect([...rows.keys()].sort()).toEqual(["orgA", "orgB"]);
  });
  it("o resultado do OAuth leva à etapa RESULT e não derruba o fluxo se o banco falhar", async () => {
    const { svc } = fake();
    await svc.recordOutcome("orgA", "u1", "no_accounts");
    expect(await svc.get("orgA")).toMatchObject({ step: "RESULT", lastOutcome: "no_accounts" });
    const quebrado = new ConnectionOnboardingService({ connectionOnboarding: { upsert: async () => { throw new Error("db"); } } } as any);
    await expect(quebrado.recordOutcome("orgA", "u1", "error")).resolves.toBeUndefined();
    await expect(quebrado.markConnecting("orgA", "u1")).resolves.toBeUndefined();
  });
});

describe("updateConnectionOnboardingSchema", () => {
  it("descarta organizationId e campos desconhecidos do corpo", () => {
    const r = updateConnectionOnboardingSchema.parse({ step: "CONNECT", organizationId: "orgB", updatedById: "x", token: "t" });
    expect(r).toEqual({ step: "CONNECT" });
  });
  it("recusa valores fora do enum", () => {
    expect(updateConnectionOnboardingSchema.safeParse({ step: "FIM" }).success).toBe(false);
    expect(updateConnectionOnboardingSchema.safeParse({ businessPortfolio: "TALVEZ" }).success).toBe(false);
  });
});
