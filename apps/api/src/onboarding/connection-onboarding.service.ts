import { Injectable } from "@nestjs/common";
import type { UpdateConnectionOnboardingDto } from "@dabi/contracts";
import { PrismaService } from "../prisma/prisma.module";

export const view = (r: any) => ({
  step: (r?.step ?? "PREPARE") as "PREPARE" | "CONNECT" | "RESULT",
  professionalAccount: r?.professionalAccount ?? null,
  businessPortfolio: r?.businessPortfolio ?? null,
  instagramInPortfolio: r?.instagramInPortfolio ?? null,
  lastOutcome: r?.lastOutcome ?? null,
});

/** Progresso do assistente de conexão. Sempre escopado pela organização que o OrgGuard validou. */
@Injectable()
export class ConnectionOnboardingService {
  constructor(private prisma: PrismaService) {}

  async get(organizationId: string) {
    return view(await this.prisma.connectionOnboarding.findUnique({ where: { organizationId } }));
  }

  async update(organizationId: string, userId: string, dto: UpdateConnectionOnboardingDto) {
    const data = { ...dto, updatedById: userId };
    return view(await this.prisma.connectionOnboarding.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data }));
  }

  /** Chamado pelo OAuth: registra o último resultado e leva o assistente à etapa de resultado. Nunca derruba o fluxo. */
  async recordOutcome(organizationId: string, userId: string, outcome: string) {
    try {
      const data = { step: "RESULT" as const, lastOutcome: outcome, updatedById: userId };
      await this.prisma.connectionOnboarding.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
    } catch { /* progresso é auxiliar */ }
  }

  /** Ao enviar o cliente para a Meta, o assistente fica na etapa de conexão (retomável). */
  async markConnecting(organizationId: string, userId: string) {
    try {
      const data = { step: "CONNECT" as const, updatedById: userId };
      await this.prisma.connectionOnboarding.upsert({ where: { organizationId }, create: { organizationId, ...data }, update: data });
    } catch { /* idem */ }
  }
}
