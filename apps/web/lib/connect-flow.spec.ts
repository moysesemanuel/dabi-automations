import { describe, expect, it } from "vitest";
import { GUIDES, OFFICIAL_HOSTS } from "./connect-guides";
import { OUTCOMES, QUESTIONS, allReady, guideFor, helpHref, initialStep, isOutcome } from "./connect-flow";

describe("guias", () => {
  it("todos têm passos e links oficiais (HTTPS, hosts da Meta/Instagram)", () => {
    for (const g of Object.values(GUIDES)) {
      expect(g.steps.length).toBeGreaterThan(2);
      expect(g.links.length).toBeGreaterThan(0);
      for (const l of g.links) {
        const u = new URL(l.url);
        expect(u.protocol).toBe("https:");
        expect(OFFICIAL_HOSTS).toContain(u.hostname);
      }
    }
  });
  it("tudo que não foi confirmado integralmente na fonte oficial continua marcado para validação", () => {
    expect(GUIDES["portfolio-find"].needsValidation?.length).toBeGreaterThan(0);
    expect(GUIDES["messages-access"].needsValidation?.length).toBeGreaterThan(0);
    expect(GUIDES.professional.needsValidation).toBeUndefined(); // confirmado na página oficial
  });
});

describe("guideFor", () => {
  it("Sim e sem resposta não mostram guia", () => {
    expect(guideFor("businessPortfolio", "YES")).toBeNull();
    expect(guideFor("businessPortfolio", null)).toBeNull();
  });
  it("Não e Não sei levam ao guia certo", () => {
    expect(guideFor("professionalAccount", "NO")).toBe("professional");
    expect(guideFor("businessPortfolio", "NO")).toBe("portfolio-create");
    expect(guideFor("businessPortfolio", "UNSURE")).toBe("portfolio-find");
    expect(guideFor("instagramInPortfolio", "UNSURE")).toBe("instagram-in-portfolio");
  });
});

describe("fluxo", () => {
  it("allReady exige as três respostas Sim", () => {
    expect(allReady({ professionalAccount: "YES", businessPortfolio: "YES", instagramInPortfolio: "YES" })).toBe(true);
    expect(allReady({ professionalAccount: "YES", businessPortfolio: "NO", instagramInPortfolio: "YES" })).toBe(false);
    expect(allReady({ professionalAccount: null, businessPortfolio: null, instagramInPortfolio: null })).toBe(false);
  });
  it("retoma a etapa salva; retorno da Meta vai ao resultado; valor inválido é ignorado", () => {
    expect(initialStep("CONNECT")).toBe("CONNECT");
    expect(initialStep("PREPARE", "cancelled")).toBe("RESULT");
    expect(initialStep("PREPARE", "lixo")).toBe("PREPARE");
  });
  it("todos os resultados da API têm mensagem; falhas oferecem nova tentativa ou ajuda", () => {
    for (const o of ["connected", "reconnected", "reconnect_mismatch", "partial", "already_connected", "other_organization", "cancelled", "expired", "forbidden", "insufficient_permissions", "no_accounts", "error"]) expect(isOutcome(o)).toBe(true);
    expect(OUTCOMES.no_accounts.guides).toContain("instagram-in-portfolio");
    expect(OUTCOMES.insufficient_permissions.guides).toContain("messages-access");
    expect(OUTCOMES.cancelled.retry).toBe(true);
    expect(OUTCOMES.connected.retry).toBe(false);
  });
  it("perguntas na ordem do assistente", () => expect(QUESTIONS.map((q) => q.key)).toEqual(["professionalAccount", "businessPortfolio", "instagramInPortfolio"]));
  it("mailto de ajuda codifica o assunto", () => expect(helpHref("a@b.co")).toBe("mailto:a@b.co?subject=Ajuda%20para%20conectar%20o%20Instagram"));
});
