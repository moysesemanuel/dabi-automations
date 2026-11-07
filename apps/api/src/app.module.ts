import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller";
import { WebhooksController } from "./webhooks/webhooks.controller";
import { WebhooksService } from "./webhooks/webhooks.service";

@Module({
  controllers: [HealthController, WebhooksController],
  providers: [WebhooksService],
})
export class AppModule {}
