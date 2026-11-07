import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { AuditService } from "./audit/audit.service";
import { AuthController } from "./auth/auth.controller";
import { AuthService } from "./auth/auth.service";
import { HealthController } from "./health/health.controller";
import { InstagramAccountsService } from "./instagram/instagram-accounts.service";
import { OrgsController } from "./orgs/orgs.controller";
import { OrgGuard } from "./orgs/org.guard";
import { PrismaModule } from "./prisma/prisma.module";
import { WebhooksController } from "./webhooks/webhooks.controller";
import { WebhooksService } from "./webhooks/webhooks.service";

@Module({
  imports: [PrismaModule, JwtModule.register({})],
  controllers: [HealthController, WebhooksController, AuthController, OrgsController],
  providers: [WebhooksService, AuthService, AuditService, OrgGuard, InstagramAccountsService],
})
export class AppModule {}
