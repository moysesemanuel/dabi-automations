"use server";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";

export interface FormState { ok?: boolean; error?: string }

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const flag = (f: FormData, k: string) => f.get(k) === "on";

/** Só traduz o formulário para o contrato; todas as regras de negócio são validadas pela API. */
function body(f: FormData) {
  const dmEnabled = flag(f, "dmEnabled");
  const publicReplyEnabled = flag(f, "publicReplyEnabled");
  const replyFormat = text(f, "replyFormat") === "BUTTON" ? "BUTTON" : "TEXT";
  return {
    keyword: text(f, "keyword"),
    replyMessage: text(f, "replyMessage") || undefined,
    linkUrl: text(f, "linkUrl") || null,
    replyFormat,
    buttonTitle: replyFormat === "BUTTON" ? text(f, "buttonTitle") || null : null,
    dmEnabled,
    publicReplyEnabled,
    publicReplyMessage: publicReplyEnabled ? text(f, "publicReplyMessage") || null : null,
  };
}

export async function createAutomation(orgId: string, _prev: FormState | undefined, f: FormData): Promise<FormState> {
  const b = body(f);
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/automations`, {
    method: "POST",
    // Na criação, campos nulos são omitidos (o contrato usa "opcional", não "nulo").
    body: {
      socialAccountId: text(f, "socialAccountId"), mediaId: text(f, "mediaId"),
      keyword: b.keyword, replyMessage: b.replyMessage ?? "-", replyFormat: b.replyFormat,
      dmEnabled: b.dmEnabled, publicReplyEnabled: b.publicReplyEnabled,
      ...(b.linkUrl ? { linkUrl: b.linkUrl } : {}),
      ...(b.buttonTitle ? { buttonTitle: b.buttonTitle } : {}),
      ...(b.publicReplyMessage ? { publicReplyMessage: b.publicReplyMessage } : {}),
    },
  });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/automacoes`);
  return { ok: true };
}

export async function updateAutomation(orgId: string, id: string, _prev: FormState | undefined, f: FormData): Promise<FormState> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/automations/${encodeURIComponent(id)}`, { method: "PATCH", body: body(f) });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/automacoes`);
  return { ok: true };
}

export async function setAutomationStatus(orgId: string, id: string, status: "ACTIVE" | "PAUSED", _prev?: FormState): Promise<FormState> {
  const r = await api(`/orgs/${encodeURIComponent(orgId)}/automations/${encodeURIComponent(id)}/status`, { method: "PATCH", body: { status } });
  if (!r.ok) return { error: r.message };
  revalidatePath(`/o/${orgId}/automacoes`);
  return { ok: true };
}
