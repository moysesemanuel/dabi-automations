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

/** Assistente de conexão do Instagram: só progresso e respostas (nunca dados sensíveis). */
export const onboardingAnswerSchema = z.enum(["YES", "NO", "UNSURE"]);
export const onboardingStepSchema = z.enum(["PREPARE", "CONNECT", "RESULT"]);
export const updateConnectionOnboardingSchema = z.object({
  step: onboardingStepSchema.optional(),
  professionalAccount: onboardingAnswerSchema.nullable().optional(),
  businessPortfolio: onboardingAnswerSchema.nullable().optional(),
  instagramInPortfolio: onboardingAnswerSchema.nullable().optional(),
}); // chaves desconhecidas (ex.: organizationId) são descartadas
export type UpdateConnectionOnboardingDto = z.infer<typeof updateConnectionOnboardingSchema>;

// ───────────────────────── Jobs da fila de comentários: formato mínimo (E2) ─────────────────────────

/**
 * Formato MÍNIMO do job: só o ID interno do evento. Nada do comentário (texto, autor, IDs da Meta) vai para o Redis;
 * o worker lê o que precisa do PostgreSQL no momento do processamento. `.strict()`: qualquer campo extra é rejeitado,
 * para que dado pessoal não volte a entrar no job por descuido.
 */
export const commentEventJobMinimalSchema = z.object({ eventId: z.string().min(1) }).strict();
export type CommentEventJobMinimal = z.infer<typeof commentEventJobMinimalSchema>;

/** Resultado da leitura de um job. "invalid" NUNCA carrega o conteúdo recebido, só um motivo fixo. */
export type ParsedCommentEventJob =
  | { kind: "legacy"; job: CommentEventJob }
  | { kind: "minimal"; job: CommentEventJobMinimal }
  | { kind: "invalid"; reason: "not_object" | "legacy_shape_invalid" | "minimal_shape_invalid" };

/**
 * Aceita os DOIS formatos durante a transição. Distingue pela presença de `commentId`: com ele, é o formato legado
 * (completo); sem ele, deve ser exatamente `{ eventId }`.
 */
export function parseCommentEventJob(raw: unknown): ParsedCommentEventJob {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { kind: "invalid", reason: "not_object" };
  if ("commentId" in raw) {
    const r = commentEventJobSchema.safeParse(raw);
    return r.success ? { kind: "legacy", job: r.data } : { kind: "invalid", reason: "legacy_shape_invalid" };
  }
  const r = commentEventJobMinimalSchema.safeParse(raw);
  return r.success ? { kind: "minimal", job: r.data } : { kind: "invalid", reason: "minimal_shape_invalid" };
}

/** Formato do job que a API enfileira. "legacy" (padrão) = comportamento anterior; "minimal" só com autorização. */
export const COMMENT_JOB_FORMATS = ["legacy", "minimal"] as const;
export type CommentJobFormat = (typeof COMMENT_JOB_FORMATS)[number];

/**
 * Resultado que o worker devolve ao BullMQ (vira `returnvalue` no Redis). SÓ o desfecho: nunca a linha do evento,
 * o payload, o texto ou o autor do comentário.
 */
export type CommentJobOutcome =
  | "processed" // fluxo concluído (inclui entrega HELD/FAILED/UNKNOWN: o estado fica no banco)
  | "ignored" // não havia o que fazer (sem automação, comentário da própria conta, conta desconhecida)
  | "dropped" // evento ausente, já tratado ou comentário já protegido por tombstone: nada enviado
  | "needs_review"; // inconsistência de associação: nada enviado, evento mantido para análise
export interface CommentJobResult { outcome: CommentJobOutcome }

// ───────────────────────── Classificação central de erros da Meta (E2) ─────────────────────────

/**
 * Classes de erro. Baseadas na tabela da página oficial "Handling Errors" da Graph API (lida em 09/11/2026) e, onde
 * indicado, na paridade com o tratamento que o worker já tinha. Quando a documentação não permite concluir, a classe é
 * OTHER (ambígua): o tratamento é conservador e NUNCA derruba a credencial nem autoriza reenvio.
 */
export type MetaErrorKind =
  | "INVALID_CREDENTIAL" // token expirado/revogado/inválido: pede reconexão
  | "USER_ACTION" // a pessoa precisa agir no Facebook (checkpoint/confirmação); NÃO é credencial inválida
  | "PERMISSION" // permissão/função/capacidade ausente (faixa 200–299, 10, 492); a credencial NÃO é marcada
  | "RATE_LIMIT" // limite de chamadas ou bloqueio temporário: a Meta recusou, nada foi enviado
  | "TRANSIENT" // falha passageira de rede/servidor numa operação de LEITURA
  | "UNKNOWN_OUTCOME" // rede/timeout/5xx numa operação de ENVIO: pode ter sido processada; nunca reenviar às cegas
  | "OTHER"; // qualquer outra rejeição ou combinação não documentada

export interface MetaErrorInput {
  /** Status HTTP, se houve resposta. */
  http?: number;
  /** `error.code` da resposta da Meta. */
  code?: number;
  /** `error.error_subcode`. */
  subcode?: number;
  /** Sem resposta utilizável: rede, timeout, conexão interrompida. */
  network?: boolean;
  /** Leitura (padrão) ou envio. Em envio, uma falha ambígua é UNKNOWN_OUTCOME, não TRANSIENT. */
  operation?: "read" | "send";
}

// 190: subcódigos que a documentação diz exigir nova autenticação/token.
const REAUTH_190 = new Set([458, 460, 463, 467]);
// 190: o usuário precisa resolver algo em facebook.com (checkpoint / conta não confirmada).
const USER_ACTION_190 = new Set([459, 464]);
// Limites: 4 e 17 (página oficial) + 32 e 613 (paridade com o worker, que já os tratava como limite). 368 = bloqueio temporário.
const RATE_LIMIT_CODES_META = new Set([4, 17, 32, 613, 368]);

/**
 * Classifica uma resposta de erro da Meta SEM presumir. Pontos importantes:
 * - código 200–299 e 10 são PERMISSÃO, não token inválido: não derrubam a credencial;
 * - 190 sem subcódigo ou com subcódigo não listado: continua INVALID_CREDENTIAL (a doc o define como token expirado/inválido),
 *   exceto 459/464 (USER_ACTION) e 492 (PERMISSION, função de Página);
 * - 102: com subcódigo é ambíguo (a doc manda verificar o subcódigo) → OTHER; sem subcódigo → INVALID_CREDENTIAL;
 * - sem resposta (rede) ou 5xx: leitura → TRANSIENT; envio → UNKNOWN_OUTCOME;
 * - HTTP 429 é RATE_LIMIT.
 */
export function classifyMetaError(e: MetaErrorInput): MetaErrorKind {
  const send = e.operation === "send";
  const code = e.code === undefined || e.code === null ? undefined : Number(e.code);
  const sub = e.subcode === undefined || e.subcode === null ? undefined : Number(e.subcode);
  const ambiguous = () => (send ? "UNKNOWN_OUTCOME" : "TRANSIENT") as MetaErrorKind;

  if (e.network) return ambiguous();
  if (e.http === 429) return "RATE_LIMIT";
  if (code === undefined) return e.http !== undefined && e.http >= 500 ? ambiguous() : "OTHER";

  if (code === 190) {
    if (sub !== undefined && USER_ACTION_190.has(sub)) return "USER_ACTION";
    if (sub === 492) return "PERMISSION";
    return "INVALID_CREDENTIAL"; // 458, 460, 463, 467, sem subcódigo e subcódigos não listados
  }
  if (code === 102) return sub === undefined ? "INVALID_CREDENTIAL" : "OTHER";
  if ((code >= 200 && code <= 299) || code === 10) return "PERMISSION";
  if (RATE_LIMIT_CODES_META.has(code)) return "RATE_LIMIT";
  if (e.http !== undefined && e.http >= 500) return ambiguous();
  return "OTHER";
}

/** Só INVALID_CREDENTIAL pede reconexão da credencial. Nenhuma outra classe a derruba. */
export const flagsCredentialForReconnect = (k: MetaErrorKind) => k === "INVALID_CREDENTIAL";
