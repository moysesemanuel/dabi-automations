import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { createInvitationSchema, updateMemberRoleSchema, acceptInvitationNewUserSchema, type CreateInvitationDto, type UpdateMemberRoleDto, type AcceptInvitationNewUserDto } from "@dabi/contracts";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ZodPipe } from "../auth/zod.pipe";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { InvitationsService } from "./invitations.service";
import { TeamService } from "./team.service";

/** Equipe da organização: só OWNER/ADMIN enxergam e gerenciam. */
@Controller("orgs/:orgId")
@UseGuards(JwtAuthGuard, OrgGuard)
export class TeamController {
  constructor(private team: TeamService) {}
  private actor = (req: any) => ({ userId: req.user.id, role: req.membership.role });

  @Get("members") @Roles("OWNER", "ADMIN")
  members(@Param("orgId") orgId: string) { return this.team.members(orgId); }

  @Get("invitations") @Roles("OWNER", "ADMIN")
  invitations(@Param("orgId") orgId: string) { return this.team.invitations(orgId); }

  @Post("invitations") @Roles("OWNER", "ADMIN")
  invite(@Param("orgId") orgId: string, @Req() req: any, @Body(new ZodPipe(createInvitationSchema)) dto: CreateInvitationDto) {
    return this.team.invite(orgId, this.actor(req), dto);
  }

  @Delete("invitations/:id") @Roles("OWNER", "ADMIN")
  revoke(@Param("orgId") orgId: string, @Param("id") id: string, @Req() req: any) { return this.team.revoke(orgId, this.actor(req), id); }

  // Sair da organização é permitido a qualquer membro (a regra fina fica no serviço).
  @Delete("members/:userId")
  remove(@Param("orgId") orgId: string, @Param("userId") userId: string, @Req() req: any) { return this.team.remove(orgId, this.actor(req), userId); }

  @Patch("members/:userId") @Roles("OWNER")
  role(@Param("orgId") orgId: string, @Param("userId") userId: string, @Req() req: any, @Body(new ZodPipe(updateMemberRoleSchema)) dto: UpdateMemberRoleDto) {
    return this.team.changeRole(orgId, this.actor(req), userId, dto.role);
  }
}

/** Aceite de convite: rotas fora de /orgs porque quem chama ainda não pertence à organização. */
@Controller("invitations")
export class InvitationsController {
  constructor(private inv: InvitationsService) {}

  @Get(":token") preview(@Param("token") token: string) { return this.inv.preview(token); }

  @Post(":token/accept-new") @HttpCode(200)
  acceptNew(@Param("token") token: string, @Body(new ZodPipe(acceptInvitationNewUserSchema)) dto: AcceptInvitationNewUserDto) { return this.inv.acceptNew(token, dto); }

  @Post(":token/accept") @HttpCode(200) @UseGuards(JwtAuthGuard)
  accept(@Param("token") token: string, @Req() req: any) { return this.inv.acceptExisting(token, req.user.id); }
}
