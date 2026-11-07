import { Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OrgGuard, Roles } from "../orgs/org.guard";
import { MediaService } from "./media.service";

@Controller("orgs/:orgId")
@UseGuards(JwtAuthGuard, OrgGuard)
export class MediaController {
  constructor(private media: MediaService) {}

  @Post("accounts/:accountId/media/sync")
  @Roles("OWNER", "ADMIN")
  sync(@Param("orgId") orgId: string, @Param("accountId") accountId: string, @Req() req: any) {
    return this.media.sync(orgId, accountId, req.user.id);
  }

  @Get("media")
  list(@Param("orgId") orgId: string, @Query("accountId") accountId?: string) {
    return this.media.list(orgId, accountId);
  }
}
