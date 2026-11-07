import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrgGuard } from "../orgs/org.guard";
import { DashboardService } from "./dashboard.service";

const num = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));

/** Leituras do painel. Todas exigem login e participação na organização (OrgGuard). */
@Controller("orgs/:orgId")
@UseGuards(JwtAuthGuard, OrgGuard)
export class DashboardController {
  constructor(private svc: DashboardService) {}

  @Get("accounts") accounts(@Param("orgId") orgId: string) { return this.svc.accounts(orgId); }
  @Get("overview") overview(@Param("orgId") orgId: string) { return this.svc.overview(orgId); }

  @Get("deliveries")
  deliveries(@Param("orgId") orgId: string, @Query("status") status?: string, @Query("automationId") automationId?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.svc.history(orgId, "dm", { status, automationId, page: num(page), pageSize: num(pageSize) });
  }

  @Get("public-replies")
  publicReplies(@Param("orgId") orgId: string, @Query("status") status?: string, @Query("automationId") automationId?: string, @Query("page") page?: string, @Query("pageSize") pageSize?: string) {
    return this.svc.history(orgId, "public", { status, automationId, page: num(page), pageSize: num(pageSize) });
  }
}
