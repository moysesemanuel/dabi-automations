import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadEnv } from "@dabi/config";
import { AppModule } from "./app.module";

async function bootstrap() {
  const env = loadEnv();
  // rawBody é necessário para validar a assinatura X-Hub-Signature-256 da Meta
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  await app.listen(env.API_PORT);
}
bootstrap();
