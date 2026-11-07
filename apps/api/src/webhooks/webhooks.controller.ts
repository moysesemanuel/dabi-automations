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
    // TEMPORÁRIO (debug do webhook): remover depois de validar a integração. Não logar corpo nem assinatura.
    console.log("[META] POST recebido", {
      hasSignature: Boolean(sig),
      hasRawBody: Boolean(req.rawBody),
      timestamp: new Date().toISOString(),
    });

    if (!isValidMetaSignature(req.rawBody, sig, this.env.META_APP_SECRET)) {
      console.warn("[META] Assinatura inválida");
      throw new ForbiddenException();
    }

    console.log("[META] Assinatura validada");

    await this.service.ingest(req.body);

    console.log("[META] Evento processado pela ingestão");

    return { received: true };
  }
}
