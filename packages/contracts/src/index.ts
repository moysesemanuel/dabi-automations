import { z } from "zod";

export const QUEUES = { COMMENT_EVENTS: "comment-events" } as const;

/** Limites do generic template (docs da Meta: título 80 caracteres). O rótulo do botão segue o limite de 20 usado pela Meta. */
export const BUTTON_TITLE_MAX = 20;
export const TEMPLATE_TITLE_MAX = 80;
export const DEFAULT_BUTTON_TITLE = "Acessar";

export const replyFormatSchema = z.enum(["TEXT", "BUTTON"]);
export type ReplyFormat = z.infer<typeof replyFormatSchema>;

/** Regras entre campos (valem na criação, na edição já mesclada e no worker). Retorna a mensagem de erro ou null. */
export function validateReplyShape(a: { replyFormat?: string | null; replyMessage: string; linkUrl?: string | null; buttonTitle?: string | null }): string | null {
  if ((a.replyFormat ?? "TEXT") !== "BUTTON") return null;
  if (!a.linkUrl) return "O formato BUTTON exige linkUrl.";
  if (!/^https:\/\//i.test(a.linkUrl)) return "O botão exige um link https.";
  if (a.replyMessage.length > TEMPLATE_TITLE_MAX) return `No formato BUTTON a mensagem tem no máximo ${TEMPLATE_TITLE_MAX} caracteres.`;
  if (a.buttonTitle && a.buttonTitle.length > BUTTON_TITLE_MAX) return `O rótulo do botão tem no máximo ${BUTTON_TITLE_MAX} caracteres.`;
  return null;
}

export const createAutomationSchema = z
  .object({
    socialAccountId: z.string().min(1),
    mediaId: z.string().min(1),
    keyword: z.string().trim().min(1).max(50),
    replyMessage: z.string().trim().min(1).max(1000),
    linkUrl: z.string().url().optional(),
    replyFormat: replyFormatSchema.default("TEXT"),
    buttonTitle: z.string().trim().min(1).max(BUTTON_TITLE_MAX).optional(),
  })
  .superRefine((v, ctx) => {
    const err = validateReplyShape(v);
    if (err) ctx.addIssue({ code: "custom", message: err });
  });
export type CreateAutomationDto = z.infer<typeof createAutomationSchema>;

/** Job enfileirado pela API e consumido pelo worker. */
export const commentEventJobSchema = z.object({
  eventId: z.string(),
  igAccountId: z.string(),
  commentId: z.string(),
  mediaId: z.string(),
  text: z.string(),
  /** Autor do comentário (para ignorar comentários da própria conta). */
  fromId: z.string().optional(),
});
export type CommentEventJob = z.infer<typeof commentEventJobSchema>;

export const normalizeKeyword = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

export const registerSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(10).max(128),
  name: z.string().trim().min(1).max(100).optional(),
  organizationName: z.string().trim().min(2).max(100),
});
export type RegisterDto = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email().toLowerCase(),
  password: z.string().min(1).max(128),
});
export type LoginDto = z.infer<typeof loginSchema>;

export const updateAutomationSchema = z
  .object({
    keyword: z.string().trim().min(1).max(50).optional(),
    replyMessage: z.string().trim().min(1).max(1000).optional(),
    linkUrl: z.string().url().nullable().optional(),
    replyFormat: replyFormatSchema.optional(),
    buttonTitle: z.string().trim().min(1).max(BUTTON_TITLE_MAX).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Informe ao menos um campo" });
export type UpdateAutomationDto = z.infer<typeof updateAutomationSchema>;

export const setAutomationStatusSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });
export type SetAutomationStatusDto = z.infer<typeof setAutomationStatusSchema>;
