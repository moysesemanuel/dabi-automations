import { Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, Req } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { loadEnv } from "@dabi/config";
import { isValidMetaSignature } from "./signature";
import { WebhooksService } from "./webhooks.service";

@Controller("webhooks/instagram")
export class WebhooksController {
  private env = loadEnv();
  constructor(private readonly service: WebhooksService) {}

  // Handshake de verificação do webhook da Meta
  @Get()
  verify(@Query("hub.mode") mode: string, @Query("hub.verify_token") token: string, @Query("hub.challenge") challenge: string) {
    if (mode === "subscribe" && token === this.env.META_WEBHOOK_VERIFY_TOKEN) return challenge;
    throw new ForbiddenException();
  }

  // Valida assinatura, grava e enfileira. Nenhum processamento pesado aqui.
  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Headers("x-hub-signature-256") sig?: string) {
    if (!isValidMetaSignature(req.rawBody, sig, this.env.META_APP_SECRET)) throw new ForbiddenException();
    await this.service.ingest(req.body);
    return { received: true };
  }
}
