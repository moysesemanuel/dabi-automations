import { z } from "zod";

export const QUEUES = { COMMENT_EVENTS: "comment-events" } as const;

/** Limites do generic template (docs da Meta: título 80 caracteres). O rótulo do botão segue o limite de 20 usado pela Meta. */
export const BUTTON_TITLE_MAX = 20;
export const TEMPLATE_TITLE_MAX = 80;
export const DEFAULT_BUTTON_TITLE = "Acessar";

export const replyFormatSchema = z.enum(["TEXT", "BUTTON"]);
export type ReplyFormat = z.infer<typeof replyFormatSchema>;

export const PUBLIC_REPLY_MAX = 300;

type ReplyShape = {
  replyFormat?: string | null; replyMessage: string; linkUrl?: string | null; buttonTitle?: string | null;
  dmEnabled?: boolean | null; publicReplyEnabled?: boolean | null; publicReplyMessage?: string | null;
};

/** Regras entre campos (valem na criação, na edição já mesclada e no worker). Retorna a mensagem de erro ou null. */
export function validateReplyShape(a: ReplyShape): string | null {
  const dm = a.dmEnabled !== false;
  const pub = a.publicReplyEnabled === true;
  if (!dm && !pub) return "Ative ao menos uma ação: mensagem privada ou resposta pública.";
  if (pub && !a.publicReplyMessage?.trim()) return "Escreva a mensagem da resposta pública.";
  if (pub && (a.publicReplyMessage?.length ?? 0) > PUBLIC_REPLY_MAX) return `A resposta pública pode ter no máximo ${PUBLIC_REPLY_MAX} caracteres.`;
  if (!dm || (a.replyFormat ?? "TEXT") !== "BUTTON") return null;
  if (!a.linkUrl) return "O formato com botão exige um link.";
  if (!/^https:\/\//i.test(a.linkUrl)) return "No formato com botão, o link precisa começar com https://.";
  if (a.replyMessage.length > TEMPLATE_TITLE_MAX) return `No formato com botão, a mensagem pode ter no máximo ${TEMPLATE_TITLE_MAX} caracteres.`;
  if (a.buttonTitle && a.buttonTitle.length > BUTTON_TITLE_MAX) return `O texto do botão pode ter no máximo ${BUTTON_TITLE_MAX} caracteres.`;
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
    dmEnabled: z.boolean().default(true),
    publicReplyEnabled: z.boolean().default(false),
    publicReplyMessage: z.string().trim().min(1).max(PUBLIC_REPLY_MAX).optional(),
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
    dmEnabled: z.boolean().optional(),
    publicReplyEnabled: z.boolean().optional(),
    publicReplyMessage: z.string().trim().min(1).max(PUBLIC_REPLY_MAX).nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "Informe ao menos um campo" });
export type UpdateAutomationDto = z.infer<typeof updateAutomationSchema>;

export const setAutomationStatusSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });
export type SetAutomationStatusDto = z.infer<typeof setAutomationStatusSchema>;

/** Papéis que podem ser concedidos por convite ou alteração (OWNER não é concedido: nasce com a organização). */
export const grantableRoleSchema = z.enum(["ADMIN", "MEMBER"]);
export type GrantableRole = z.infer<typeof grantableRoleSchema>;

export const INVITATION_TTL_DAYS = 7;

export const createInvitationSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.string().email()),
  role: grantableRoleSchema.default("MEMBER"),
});
export type CreateInvitationDto = z.infer<typeof createInvitationSchema>;

export const acceptInvitationNewUserSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  password: z.string().min(10).max(128),
});
export type AcceptInvitationNewUserDto = z.infer<typeof acceptInvitationNewUserSchema>;

export const updateMemberRoleSchema = z.object({ role: grantableRoleSchema });
export type UpdateMemberRoleDto = z.infer<typeof updateMemberRoleSchema>;

/** Retorno do OAuth do Instagram (o web repassa o que a Meta enviou na query). */
export const completeInstagramOAuthSchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(2000).optional(),
  error: z.string().max(100).optional(),
  errorReason: z.string().max(100).optional(),
});
export type CompleteInstagramOAuthDto = z.infer<typeof completeInstagramOAuthSchema>;
