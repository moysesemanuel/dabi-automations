export type Role = "OWNER" | "ADMIN" | "MEMBER";
export type DeliveryStatus = "PENDING" | "HELD" | "SENT" | "FAILED" | "UNKNOWN";

export interface Membership { role: Role; organization: { id: string; name: string } }
export interface Profile { id: string; email: string; name: string | null }

export interface Account {
  id: string; username: string; providerAccountId: string; createdAt: string; mediaCount: number; automationCount: number;
  webhookStatus: "UNKNOWN" | "SUBSCRIBED" | "FAILED"; webhookSubscribedAt: string | null; webhookError: string | null;
  credential: { connected: false } | { connected: true; loginMode: "INSTAGRAM" | "FACEBOOK"; expiresAt: string | null; scopes: string[]; updatedAt: string };
}

export interface Overview {
  accounts: number; media: number; automations: { active: number; paused: number };
  directMessages: Record<DeliveryStatus, number>; publicReplies: Record<DeliveryStatus, number>;
  sending: { directMessages: boolean; publicReplies: boolean };
}

export interface MediaItem { id: string; socialAccountId: string; providerMediaId: string; permalink: string | null; caption: string | null; mediaType: string | null; createdAt: string }

export interface Automation {
  id: string; socialAccountId: string; mediaId: string; keyword: string; replyMessage: string; linkUrl: string | null;
  replyFormat: "TEXT" | "BUTTON"; buttonTitle: string | null; dmEnabled: boolean; publicReplyEnabled: boolean; publicReplyMessage: string | null;
  status: "ACTIVE" | "PAUSED"; createdAt: string; media: { providerMediaId: string; permalink: string | null };
}

export interface HistoryItem {
  id: string; commentId: string; status: DeliveryStatus; attempts: number; error: string | null; createdAt: string; updatedAt: string;
  provider: { code?: number; error_subcode?: number; fbtrace_id?: string; http?: number; rateLimited?: boolean; replyId?: string; messageId?: string } | null;
  automation: { id: string; keyword: string; permalink: string | null };
}
export interface History { page: number; pageSize: number; total: number; totalPages: number; items: HistoryItem[] }

export const canWrite = (role: Role) => role === "OWNER" || role === "ADMIN";

export interface Member { userId: string; email: string; name: string | null; role: Role }
export interface Invitation { id: string; email: string; role: Role; expiresAt: string; createdAt: string; expired: boolean }
export const roleLabel: Record<Role, string> = { OWNER: "Proprietário", ADMIN: "Administrador", MEMBER: "Membro" };

export type OnboardingAnswer = "YES" | "NO" | "UNSURE";
export type OnboardingStep = "PREPARE" | "CONNECT" | "RESULT";
export interface ConnectionOnboarding {
  step: OnboardingStep;
  professionalAccount: OnboardingAnswer | null;
  businessPortfolio: OnboardingAnswer | null;
  instagramInPortfolio: OnboardingAnswer | null;
  lastOutcome: string | null;
  helpEmail: string | null;
}
