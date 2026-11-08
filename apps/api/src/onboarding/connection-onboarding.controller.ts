import { Body, Controller, Get, Param, Put, Req, UseGuards } from "@nestjs/common";
import { loadEnv } from "@dabi/config";
import { updateConnectionOnboardingSchema, type UpdateConnectionOnboardingDto } from "@dabi/contracts";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ZodPipe } from "../auth/zod.pipe";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { ConnectionOnboardingService } from "./connection-onboarding.service";

/** Só OWNER/ADMIN: são os que podem conectar contas. A organização vem do caminho (validada pelo OrgGuard), nunca do corpo. */
@Controller("orgs/:orgId/connection-onboarding")
@UseGuards(JwtAuthGuard, OrgGuard)
@Roles("OWNER", "ADMIN")
export class ConnectionOnboardingController {
  constructor(private svc: ConnectionOnboardingService) {}

  @Get()
  async get(@Param("orgId") orgId: string) {
    return { ...(await this.svc.get(orgId)), helpEmail: loadEnv().SUPPORT_EMAIL || null };
  }

  @Put()
  async update(@Param("orgId") orgId: string, @Req() req: any, @Body(new ZodPipe(updateConnectionOnboardingSchema)) dto: UpdateConnectionOnboardingDto) {
    return { ...(await this.svc.update(orgId, req.user.id, dto)), helpEmail: loadEnv().SUPPORT_EMAIL || null };
  }
}
