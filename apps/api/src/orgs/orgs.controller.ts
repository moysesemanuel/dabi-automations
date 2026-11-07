import { Controller, Get, Param, Req, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { PrismaService } from "../prisma/prisma.module";
import { OrgGuard } from "./org.guard";

@Controller()
@UseGuards(JwtAuthGuard)
export class OrgsController {
  constructor(private prisma: PrismaService) {}

  @Get("me")
  me(@Req() req: any) {
    return this.prisma.membership.findMany({
      where: { userId: req.user.id },
      select: { role: true, organization: { select: { id: true, name: true } } },
    });
  }

  @Get("orgs/:orgId")
  @UseGuards(OrgGuard)
  org(@Param("orgId") orgId: string) {
    return this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { id: true, name: true } });
  }
}
