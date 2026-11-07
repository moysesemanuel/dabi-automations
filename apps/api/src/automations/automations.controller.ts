import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import {
  createAutomationSchema, setAutomationStatusSchema, updateAutomationSchema,
  type CreateAutomationDto, type SetAutomationStatusDto, type UpdateAutomationDto,
} from "@dabi/contracts";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ZodPipe } from "../auth/zod.pipe";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { AutomationsService } from "./automations.service";

@Controller("orgs/:orgId/automations")
@UseGuards(JwtAuthGuard, OrgGuard)
export class AutomationsController {
  constructor(private svc: AutomationsService) {}

  @Get()
  list(@Param("orgId") orgId: string) { return this.svc.list(orgId); }

  @Post() @Roles("OWNER", "ADMIN")
  create(@Param("orgId") orgId: string, @Req() req: any, @Body(new ZodPipe(createAutomationSchema)) dto: CreateAutomationDto) {
    return this.svc.create(orgId, req.user.id, dto);
  }

  @Patch(":id") @Roles("OWNER", "ADMIN")
  update(@Param("orgId") orgId: string, @Param("id") id: string, @Req() req: any, @Body(new ZodPipe(updateAutomationSchema)) dto: UpdateAutomationDto) {
    return this.svc.update(orgId, req.user.id, id, dto);
  }

  @Patch(":id/status") @Roles("OWNER", "ADMIN")
  status(@Param("orgId") orgId: string, @Param("id") id: string, @Req() req: any, @Body(new ZodPipe(setAutomationStatusSchema)) dto: SetAutomationStatusDto) {
    return this.svc.setStatus(orgId, req.user.id, id, dto.status);
  }
}
