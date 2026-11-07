import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { LoginThrottle } from "./auth/login-throttle";
import { DashboardController } from "./dashboard/dashboard.controller";
import { DashboardService } from "./dashboard/dashboard.service";
import { HealthController } from "./health/health.controller";
import { InstagramAccountsService } from "./instagram/instagram-accounts.service";
import { AutomationsController } from "./automations/automations.controller";
import { AutomationsService } from "./automations/automations.service";
import { MediaController } from "./media/media.controller";
import { MediaService } from "./media/media.service";
import { OrgsController } from "./orgs/orgs.controller";
import { OrgGuard } from "./orgs/org.guard";
import { PrismaModule } from "./prisma/prisma.module";
import { InvitationsController, TeamController } from "./team/team.controller";
import { InvitationsService } from "./team/invitations.service";
import { TeamService } from "./team/team.service";
import { WebhooksController } from "./webhooks/webhooks.controller";
import { WebhooksService } from "./webhooks/webhooks.service";

@Module({
  imports: [PrismaModule, JwtModule.register({})],
  controllers: [HealthController, WebhooksController, AuthController, OrgsController, MediaController, AutomationsController, DashboardController, TeamController, InvitationsController],
  providers: [WebhooksService, AuthService, LoginThrottle, AuditService, OrgGuard, InstagramAccountsService, MediaService, AutomationsService, DashboardService, TeamService, InvitationsService],
})
export class AppModule {}
