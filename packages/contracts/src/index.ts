import { z } from "zod";

export const QUEUES = { COMMENT_EVENTS: "comment-events" } as const;

export const createAutomationSchema = z.object({
  socialAccountId: z.string().min(1),
  mediaId: z.string().min(1),
  keyword: z.string().trim().min(1).max(50),
  replyMessage: z.string().trim().min(1).max(1000),
  linkUrl: z.string().url().optional(),
});
export type CreateAutomationDto = z.infer<typeof createAutomationSchema>;

/** Job enfileirado pela API e consumido pelo worker. */
export const commentEventJobSchema = z.object({
  eventId: z.string(),
  igAccountId: z.string(),
  commentId: z.string(),
  mediaId: z.string(),
  text: z.string(),
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
