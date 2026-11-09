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

// ───────────────────────── Estado exibido derivado do estado real (E2/P1 e observabilidade) ─────────────────────────

/**
 * Razões de NÍVEL DE EVENTO: as que não existem em nenhuma entrega. São as únicas que o worker grava em
 * `AutomationEvent.error`, sempre como CÓDIGO estável. O estado de envio NUNCA é copiado para o evento: é derivado, na
 * leitura, de `MessageDelivery` e `PublicReply` (que são a verdade), por `deriveEventView`.
 */
export const EVENT_REASONS = {
  "needs_review.ig_account_missing": { kind: "needs_review", severity: "attention", label: "Requer análise: conta não identificada", detail: "O evento não trouxe uma conta do Instagram conectada. O processamento foi interrompido para análise." },
  "needs_review.association_mismatch": { kind: "needs_review", severity: "attention", label: "Requer análise: associação inconsistente", detail: "A conta ou a organização gravada no evento não bate com a conta encontrada. O processamento foi interrompido para análise." },
  "needs_review.payload_without_comment": { kind: "needs_review", severity: "attention", label: "Requer análise: comentário não identificado", detail: "O conteúdo recebido não permitiu identificar o comentário. O processamento foi interrompido para análise." },
  "dropped.tombstone": { kind: "dropped", severity: "info", label: "Descartado: comentário já tratado", detail: "Este comentário já tinha sido tratado e seus registros foram apagados. O DaBiChat não o processou de novo." },
  "ignored.account_unknown": { kind: "ignored", severity: "info", label: "Ignorado: conta desconhecida", detail: "A conta do Instagram do evento não está conectada ao DaBiChat." },
  "ignored.own_comment": { kind: "ignored", severity: "info", label: "Ignorado: comentário da própria conta", detail: "Comentários da própria conta nunca recebem resposta automática." },
  "ignored.no_automation": { kind: "ignored", severity: "info", label: "Ignorado: nenhuma automação correspondente", detail: "Nenhuma automação ativa casou com a publicação e a palavra-chave." },
  "ignored.no_action_enabled": { kind: "ignored", severity: "info", label: "Ignorado: nenhuma ação habilitada", detail: "A automação não tem DM nem resposta pública habilitadas." },
  "failed.org_mismatch": { kind: "failed", severity: "error", label: "Falhou: organização divergente", detail: "A organização da automação difere da conta. O processamento foi interrompido." },
  "failed.delivery_foreign": { kind: "failed", severity: "error", label: "Falhou: entrega de outra automação", detail: "Já existia uma entrega deste comentário ligada a outra automação ou organização. O processamento foi interrompido." },
} as const;
export type EventReasonCode = keyof typeof EVENT_REASONS;

/** Textos antigos (anteriores aos códigos) que continuam reconhecidos nos registros já gravados. */
const LEGACY_REASON_TEXT = new Map<string, EventReasonCode>([
  ["conta desconhecida", "ignored.account_unknown"],
  ["comentário da própria conta", "ignored.own_comment"],
  ["nenhuma ação habilitada na automação", "ignored.no_action_enabled"],
  ["organização da automação difere da conta", "failed.org_mismatch"],
  ["entrega existente pertence a outra automação/organização", "failed.delivery_foreign"],
]);

/** Código da razão de evento a partir da nota gravada (código novo ou texto antigo). Notas derivadas de entrega → null. */
export function eventReasonFromNote(note: string | null | undefined): EventReasonCode | null {
  if (!note) return null;
  if (Object.prototype.hasOwnProperty.call(EVENT_REASONS, note)) return note as EventReasonCode;
  return LEGACY_REASON_TEXT.get(note) ?? null; // Map: chaves como "toString" ou "__proto__" não herdam nada
}

export type DeliveryLike = { status: DeliveryStatusValue; attempts?: number; error?: string | null };
export type DeliveryStatusValue = "PENDING" | "HELD" | "SENT" | "FAILED" | "UNKNOWN" | "CANCELED";

export type ViewState = "needs_review" | "dropped" | "ignored" | "failed" | "sent" | "unknown" | "held" | "canceled" | "pending" | "received";
export interface EventView {
  state: ViewState;
  severity: "info" | "attention" | "error";
  headline: string;
  detail: string;
  /** Razão de nível de evento, quando houver. */
  reason?: EventReasonCode;
}

/**
 * Apresentação de cada estado de ENVIO. Regras de linguagem:
 * - HELD: retido por segurança/configuração; nada foi enviado.
 * - UNKNOWN: resultado NÃO confirmado; a mensagem pode ou não ter sido entregue. NUNCA apresentar como "não enviada".
 * - CANCELED: decisão nossa de não enviar; não é confirmação da Meta.
 */
const DELIVERY_VIEW: Record<DeliveryStatusValue, { state: ViewState; severity: EventView["severity"]; headline: string; detail: string }> = {
  SENT: { state: "sent", severity: "info", headline: "Enviada", detail: "A Meta confirmou o envio." },
  FAILED: { state: "failed", severity: "error", headline: "Falhou", detail: "A Meta recusou ou a automação era inválida. Nada foi enviado." },
  UNKNOWN: { state: "unknown", severity: "attention", headline: "Resultado não confirmado", detail: "Não sabemos se a mensagem foi entregue: ela pode ter sido enviada. Confira no Instagram. O DaBiChat não reenvia automaticamente." },
  HELD: { state: "held", severity: "attention", headline: "Retida", detail: "O envio está retido pelas configurações de segurança (envio desligado ou credencial a reconectar). Nada foi enviado." },
  CANCELED: { state: "canceled", severity: "info", headline: "Cancelada", detail: "Decidimos não enviar. Isto não é uma confirmação da Meta de que nada saiu." },
  PENDING: { state: "pending", severity: "info", headline: "Aguardando", detail: "Ainda sendo processada." },
};

/**
 * Estado exibido de um evento, DERIVADO do estado real da entrega (DM) e da resposta pública. Nunca lê notas de envio
 * gravadas no evento: só a razão de nível de evento (código), que é a única coisa que o evento sabe sozinho.
 * Prioridade: razão de evento → DM → resposta pública → aguardando processamento.
 */
export function deriveEventView(ev: { status: string; error?: string | null }, dm?: DeliveryLike | null, pub?: DeliveryLike | null, opts: { noDeliveryRecords?: boolean } = {}): EventView {
  // IGNORED sem nota é o caso 'nenhuma automação casou' (o worker não grava texto para ele).
  const reason = eventReasonFromNote(ev.error) ?? (ev.status === "IGNORED" ? "ignored.no_automation" : null);
  if (reason) {
    const r = EVENT_REASONS[reason];
    const state: ViewState = r.kind;
    let detail: string = r.detail;
    if (r.kind === "needs_review") {
      // Sem frase absoluta. A ausência de MessageDelivery/PublicReply indica que o DaBiChat NÃO chamou a Meta para este comentário
      // (o registro é criado antes de qualquer chamada; só o worker envia, e só por /messages e /replies: travado por testes), mas
      // NÃO prova que nada saiu: não cobre mensagens enviadas por outros meios (respostas manuais, outras ferramentas) nem registros
      // que tenham sido apagados (cascatas de exclusão, retenção). Por isso a descrição é sempre prudente.
      if (opts.noDeliveryRecords === true && !dm && !pub) detail += " Não há registro de entrega do DaBiChat para este comentário: ele registra a entrega antes de qualquer chamada à Meta, então, em condições normais, não enviou nada. Isso não considera mensagens enviadas por outros meios nem registros apagados; confirme no Instagram antes de agir.";
      else if (dm || pub) detail += ` Já existe entrega registrada (${DELIVERY_VIEW[(dm ?? pub)!.status].headline.toLowerCase()}): confira o histórico antes de agir.`;
      else detail += " Não foi possível verificar se houve envio: confira o histórico e o Instagram antes de agir.";
    }
    return { state, severity: r.severity, headline: r.label, detail, reason };
  }
  const main = dm ?? pub;
  if (main) {
    const v = DELIVERY_VIEW[main.status];
    const extra = dm && pub ? ` Resposta pública: ${DELIVERY_VIEW[pub.status].headline.toLowerCase()}.` : "";
    return { state: v.state, severity: v.severity, headline: v.headline, detail: v.detail + extra };
  }
  return { state: "received", severity: "info", headline: "Recebido", detail: "Aguardando processamento." };
}

// ───────────────────────── Retenção dos registros de job no BullMQ ─────────────────────────

/** Limites aceitos para a idade de retenção, em segundos: de 1 hora a 2 anos. */
export const JOB_RETENTION_MIN_AGE_SECONDS = 3_600;
export const JOB_RETENTION_MAX_AGE_SECONDS = 63_072_000;

export interface JobRetentionConfig {
  /** Só `true` (booleano) liga a retenção. Ausente, falso ou qualquer outro valor: DESLIGADA. */
  enabled?: boolean;
  completedMaxAgeSeconds?: number;
  failedMaxAgeSeconds?: number;
}

/** Problemas na configuração de retenção (lista vazia = válida). Só faz sentido quando `enabled === true`. */
export function jobRetentionProblems(c: JobRetentionConfig): string[] {
  const p: string[] = [];
  const check = (name: string, v: unknown) => {
    if (v === undefined || v === null) p.push(`${name} é obrigatória quando a retenção está habilitada (não existe prazo padrão)`);
    else if (typeof v !== "number" || !Number.isInteger(v)) p.push(`${name} deve ser um número inteiro de segundos`);
    else if (v < JOB_RETENTION_MIN_AGE_SECONDS || v > JOB_RETENTION_MAX_AGE_SECONDS) p.push(`${name} deve estar entre ${JOB_RETENTION_MIN_AGE_SECONDS} e ${JOB_RETENTION_MAX_AGE_SECONDS} segundos`);
  };
  check("COMPLETED_JOB_MAX_AGE_SECONDS", c.completedMaxAgeSeconds);
  check("FAILED_JOB_MAX_AGE_SECONDS", c.failedMaxAgeSeconds);
  return p;
}

/**
 * Opções de retenção dos registros de job (BullMQ) para API e worker. DESABILITADA POR PADRÃO: sem habilitação explícita
 * devolve `{}` (nenhum removeOnComplete/removeOnFail), e o BullMQ mantém os jobs. Não existe prazo padrão: habilitada sem os dois
 * prazos, ou com prazo inválido, é ERRO. A remoção por idade do BullMQ é preguiçosa (ocorre quando outro job termina).
 */
export function jobRetention(c: JobRetentionConfig = {}): { removeOnComplete?: { age: number }; removeOnFail?: { age: number } } {
  if (c.enabled !== true) return {};
  const problems = jobRetentionProblems(c);
  if (problems.length) throw new Error(`Retenção de jobs habilitada com configuração inválida: ${problems.join("; ")}`);
  return { removeOnComplete: { age: c.completedMaxAgeSeconds! }, removeOnFail: { age: c.failedMaxAgeSeconds! } };
}
