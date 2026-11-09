import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { loadEnv } from "@dabi/config";
import { AppModule } from "./app.module";
import { productionKeyProblems } from "./security/hmac";

async function bootstrap() {
  const env = loadEnv();
  // Em produção: chaves HMAC obrigatórias, com tamanho mínimo e independentes. Sem elas a API NÃO inicia (o limitador de
  // login nunca fica desligado ou contornável por falta de configuração, e a auditoria nunca grava e-mail em texto).
  const keyProblems = productionKeyProblems(env);
  if (keyProblems.length) throw new Error(`Configuração de segurança inválida: ${keyProblems.join("; ")}`);
  // rawBody é necessário para validar a assinatura X-Hub-Signature-256 da Meta
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // IP real do cliente só é aceito de proxies confiáveis (padrão: loopback, onde roda o servidor do painel).
  app.set("trust proxy", env.TRUST_PROXY);
  await app.listen(env.API_PORT);
}
bootstrap();
