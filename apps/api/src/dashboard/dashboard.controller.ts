import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { loadEnv } from "@dabi/config";
import { OrgGuard } from "../orgs/org.guard";
import { DashboardService } from "./dashboard.service";

const num = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));

/** Leituras do painel. Todas exigem login e participação na organização (OrgGuard). */
@Controller("orgs/:orgId")
@UseGuards(JwtAuthGuard, OrgGuard)
export class DashboardController {
  constructor(private svc: DashboardService) {}

  @Get("accounts") accounts(@Param("orgId") orgId: string) { return this.svc.accounts(orgId); }
  @Get("overview")
  async overview(@Param("orgId") orgId: string) {
    const env = loadEnv();
    // Informa ao painel se o servidor está de fato enviando (DM e resposta pública).
    return { ...(await this.svc.overview(orgId)), sending: { directMessages: env.INSTAGRAM_SEND_ENABLED === "true", publicReplies: env.INSTAGRAM_PUBLIC_REPLY_ENABLED === "true" } };
  }

  /** Eventos que requerem análise (needs_review): IDs internos e textos fixos, sem dados do comentário. */
  @Get("events/attention")
  attention(@Param("orgId") orgId: string, @Query("limit") limit?: string) { return this.svc.attention(orgId, num(limit)); }

  @Get("deliveries")
  deliveries(@Param("orgId") orgId: string, @Query("status") status?: string, @Query("automationId") automationId?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.svc.history(orgId, "dm", { status, automationId, page: num(page), pageSize: num(pageSize) });
  }

  @Get("public-replies")
  publicReplies(@Param("orgId") orgId: string, @Query("status") status?: string, @Query("automationId") automationId?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.svc.history(orgId, "public", { status, automationId, page: num(page), pageSize: num(pageSize) });
  }
}
