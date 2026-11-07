import { describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { createAutomationSchema } from "@dabi/contracts";
import { AutomationsService } from "./automations.service";

function setup() {
  const medias = [{ id: "med1", organizationId: "orgA", socialAccountId: "acc1" }];
  const autos: any[] = [];
  const audits: any[] = [];
  const match = (o: any, w: any) =>
    Object.entries(w).every(([k, v]: any) => (k === "id" && v?.not ? o.id !== v.not : o[k] === v));
  const prisma: any = {
    media: { findFirst: async ({ where }: any) => medias.find((m) => match(m, where)) ?? null },
    automation: {
      findMany: async ({ where }: any) => autos.filter((a) => match(a, where)),
      findFirst: async ({ where }: any) => autos.find((a) => match(a, where)) ?? null,
      create: async ({ data }: any) => { const a = { id: `a${autos.length + 1}`, status: "ACTIVE", ...data }; autos.push(a); return a; },
      update: async ({ where, data }: any) => Object.assign(autos.find((a) => a.id === where.id)!, data),
    },
  };
  const svc = new AutomationsService(prisma, { log: async (x: any) => { audits.push(x); } } as any);
  return { svc, autos, audits };
}
const dto = { socialAccountId: "acc1", mediaId: "med1", keyword: "LINK", replyMessage: "oi", replyFormat: "TEXT" as const, dmEnabled: true, publicReplyEnabled: false };

describe("AutomationsService", () => {
  it("cria automação ligada à organização e audita", async () => {
    const { svc, audits } = setup();
    const a = await svc.create("orgA", "u1", dto);
    expect(a.organizationId).toBe("orgA");
    expect(audits[0].action).toBe("automation.create");
  });
  it("recusa publicação de outra organização ou de outra conta", async () => {
    const { svc } = setup();
    await expect(svc.create("orgB", "u1", dto)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.create("orgA", "u1", { ...dto, socialAccountId: "accX" })).rejects.toBeInstanceOf(NotFoundException);
  });
  it("recusa palavra-chave repetida (sem acento/maiúscula) na mesma publicação", async () => {
    const { svc } = setup();
    await svc.create("orgA", "u1", { ...dto, keyword: "Café" });
    await expect(svc.create("orgA", "u1", { ...dto, keyword: "cafe" })).rejects.toBeInstanceOf(ConflictException);
  });
  it("não edita nem pausa automação de outra organização", async () => {
    const { svc } = setup();
    const a = await svc.create("orgA", "u1", dto);
    await expect(svc.update("orgB", "u2", a.id, { keyword: "X" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.setStatus("orgB", "u2", a.id, "PAUSED")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("pausa e só reativa se não houver conflito", async () => {
    const { svc } = setup();
    const a = await svc.create("orgA", "u1", dto);
    await svc.setStatus("orgA", "u1", a.id, "PAUSED");
    await svc.create("orgA", "u1", dto); // mesma palavra enquanto a primeira está pausada
    await expect(svc.setStatus("orgA", "u1", a.id, "ACTIVE")).rejects.toBeInstanceOf(ConflictException);
  });
  it("contrato: BUTTON exige link https e mensagem de até 80 caracteres", () => {
    const base = { socialAccountId: "a", mediaId: "m", keyword: "LINK", replyMessage: "Conheça", replyFormat: "BUTTON" };
    expect(createAutomationSchema.safeParse(base).success).toBe(false); // sem link
    expect(createAutomationSchema.safeParse({ ...base, linkUrl: "http://x.com" }).success).toBe(false); // não-https
    expect(createAutomationSchema.safeParse({ ...base, linkUrl: "https://x.com", replyMessage: "x".repeat(81) }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...base, linkUrl: "https://x.com", buttonTitle: "x".repeat(21) }).success).toBe(false);
    const ok = createAutomationSchema.parse({ ...base, linkUrl: "https://x.com", buttonTitle: "Ver site" });
    expect(ok.replyFormat).toBe("BUTTON");
    expect(createAutomationSchema.parse({ ...base, replyFormat: undefined }).replyFormat).toBe("TEXT"); // padrão
  });
  it("edição valida o resultado mesclado: trocar para BUTTON sem link é recusado", async () => {
    const { svc } = setup();
    const a = await svc.create("orgA", "u1", dto);
    await expect(svc.update("orgA", "u1", a.id, { replyFormat: "BUTTON" })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await svc.update("orgA", "u1", a.id, { replyFormat: "BUTTON", linkUrl: "https://x.com", buttonTitle: "Ver" });
    expect(ok.replyFormat).toBe("BUTTON");
  });
  it("contrato: resposta pública exige mensagem; ao menos uma ação habilitada", () => {
    const base = { socialAccountId: "a", mediaId: "m", keyword: "LINK", replyMessage: "oi" };
    expect(createAutomationSchema.safeParse({ ...base, publicReplyEnabled: true }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...base, publicReplyEnabled: true, publicReplyMessage: "x".repeat(301) }).success).toBe(false);
    expect(createAutomationSchema.safeParse({ ...base, dmEnabled: false }).success).toBe(false); // nenhuma ação
    const ok = createAutomationSchema.parse({ ...base, publicReplyEnabled: true, publicReplyMessage: "Prontinho! Te enviei o link no direct." });
    expect(ok).toMatchObject({ dmEnabled: true, publicReplyEnabled: true });
    expect(createAutomationSchema.parse(base)).toMatchObject({ dmEnabled: true, publicReplyEnabled: false }); // padrões
    expect(createAutomationSchema.safeParse({ ...base, dmEnabled: false, publicReplyEnabled: true, publicReplyMessage: "ok" }).success).toBe(true);
  });
  it("edição: ligar resposta pública sem mensagem é recusado", async () => {
    const { svc } = setup();
    const a = await svc.create("orgA", "u1", dto);
    await expect(svc.update("orgA", "u1", a.id, { publicReplyEnabled: true })).rejects.toBeInstanceOf(BadRequestException);
    const ok = await svc.update("orgA", "u1", a.id, { publicReplyEnabled: true, publicReplyMessage: "Prontinho!" });
    expect(ok.publicReplyEnabled).toBe(true);
  });
});
