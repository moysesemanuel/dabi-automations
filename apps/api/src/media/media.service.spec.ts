import { beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { encryptToken } from "@dabi/config";
import { MediaService } from "./media.service";

const KEY = randomBytes(32).toString("base64");
const TOKEN = "EAAP-token-de-teste-123";

beforeAll(() => {
  Object.assign(process.env, {
    DATABASE_URL: "x", REDIS_URL: "x", META_APP_SECRET: "x", META_WEBHOOK_VERIFY_TOKEN: "12345678",
    TOKEN_ENCRYPTION_KEY: KEY, JWT_SECRET: "x".repeat(20),
  });
});

function setup(mode: "FACEBOOK" | "INSTAGRAM", pages: any[]) {
  const e = encryptToken(TOKEN, KEY);
  const upserts: any[] = [];
  const audits: any[] = [];
  const prisma: any = {
    socialAccount: {
      findFirst: async ({ where }: any) =>
        where.organizationId === "orgA" && where.id === "acc1"
          ? { id: "acc1", providerAccountId: "17841", credential: { encryptedToken: e.encrypted, tokenIv: e.iv, tokenTag: e.tag, loginMode: mode } }
          : null,
    },
    media: { upsert: async (a: any) => { upserts.push(a); } },
  };
  const urls: string[] = [];
  let i = 0;
  const svc = new MediaService(prisma, { log: async (x: any) => { audits.push(x); } } as any);
  svc.fetchImpl = (async (u: string) => { urls.push(u); return { ok: true, status: 200, json: async () => pages[i++] }; }) as any;
  return { svc, upserts, urls, audits };
}

describe("MediaService.sync", () => {
  it("modo FACEBOOK usa graph.facebook.com/{ig-id}/media e grava com a organização", async () => {
    const { svc, upserts, urls } = setup("FACEBOOK", [{ data: [{ id: "m1", permalink: "p", media_type: "IMAGE" }] }]);
    expect(await svc.sync("orgA", "acc1", "u1")).toEqual({ synced: 1 });
    expect(urls[0]).toContain("https://graph.facebook.com/");
    expect(urls[0]).toContain("/17841/media?");
    expect(upserts[0].create.organizationId).toBe("orgA");
  });
  it("modo INSTAGRAM usa graph.instagram.com/me/media", async () => {
    const { svc, urls } = setup("INSTAGRAM", [{ data: [] }]);
    await svc.sync("orgA", "acc1");
    expect(urls[0]).toContain("https://graph.instagram.com/");
    expect(urls[0]).toContain("/me/media?");
  });
  it("segue a paginação", async () => {
    const { svc, urls } = setup("FACEBOOK", [
      { data: [{ id: "m1" }], paging: { next: "https://graph.facebook.com/next?x=1" } },
      { data: [{ id: "m2" }] },
    ]);
    expect((await svc.sync("orgA", "acc1")).synced).toBe(2);
    expect(urls[1]).toBe("https://graph.facebook.com/next?x=1");
  });
  it("conta de outra organização => 404", async () => {
    const { svc } = setup("FACEBOOK", []);
    await expect(svc.sync("orgB", "acc1")).rejects.toBeInstanceOf(NotFoundException);
  });
  it("não grava o token na auditoria", async () => {
    const { svc, audits } = setup("FACEBOOK", [{ data: [] }]);
    await svc.sync("orgA", "acc1", "u1");
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });
});
