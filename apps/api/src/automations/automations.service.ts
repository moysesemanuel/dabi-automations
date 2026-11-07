import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { normalizeKeyword, validateReplyShape, type CreateAutomationDto, type UpdateAutomationDto } from "@dabi/contracts";
import { PrismaService } from "../prisma/prisma.module";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class AutomationsService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  private async assertNoKeywordConflict(organizationId: string, mediaId: string, keyword: string, exceptId?: string) {
    const active = await this.prisma.automation.findMany({
      where: { organizationId, mediaId, status: "ACTIVE", ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { keyword: true },
    });
    if (active.some((a) => normalizeKeyword(a.keyword) === normalizeKeyword(keyword)))
      throw new ConflictException("Já existe automação ativa com essa palavra-chave nesta publicação.");
  }

  private async getOwned(organizationId: string, id: string) {
    const a = await this.prisma.automation.findFirst({ where: { id, organizationId } });
    if (!a) throw new NotFoundException("Automação não encontrada.");
    return a;
  }

  async create(organizationId: string, userId: string, dto: CreateAutomationDto) {
    // A publicação precisa pertencer à organização E à conta informada.
    const media = await this.prisma.media.findFirst({
      where: { id: dto.mediaId, organizationId, socialAccountId: dto.socialAccountId },
    });
    if (!media) throw new NotFoundException("Publicação não encontrada nesta conta.");
    await this.assertNoKeywordConflict(organizationId, media.id, dto.keyword);
    const a = await this.prisma.automation.create({
      data: {
        organizationId, socialAccountId: media.socialAccountId, mediaId: media.id,
        keyword: dto.keyword, replyMessage: dto.replyMessage, linkUrl: dto.linkUrl ?? null,
        replyFormat: dto.replyFormat, buttonTitle: dto.buttonTitle ?? null,
        dmEnabled: dto.dmEnabled, publicReplyEnabled: dto.publicReplyEnabled, publicReplyMessage: dto.publicReplyMessage ?? null,
      },
    });
    await this.audit.log({ action: "automation.create", organizationId, userId, entityType: "Automation", entityId: a.id });
    return a;
  }

  list(organizationId: string) {
    return this.prisma.automation.findMany({
      where: { organizationId },
      orderBy: { createdAt: "desc" },
      include: { media: { select: { providerMediaId: true, permalink: true } } },
    });
  }

  async update(organizationId: string, userId: string, id: string, dto: UpdateAutomationDto) {
    const current = await this.getOwned(organizationId, id);
    // Regras entre campos valem sobre o resultado já mesclado.
    const merged = {
      replyFormat: dto.replyFormat ?? current.replyFormat,
      replyMessage: dto.replyMessage ?? current.replyMessage,
      linkUrl: dto.linkUrl === undefined ? current.linkUrl : dto.linkUrl,
      buttonTitle: dto.buttonTitle === undefined ? current.buttonTitle : dto.buttonTitle,
      dmEnabled: dto.dmEnabled ?? current.dmEnabled,
      publicReplyEnabled: dto.publicReplyEnabled ?? current.publicReplyEnabled,
      publicReplyMessage: dto.publicReplyMessage === undefined ? current.publicReplyMessage : dto.publicReplyMessage,
    };
    const shapeError = validateReplyShape(merged);
    if (shapeError) throw new BadRequestException(shapeError);
    if (dto.keyword && current.status === "ACTIVE") await this.assertNoKeywordConflict(organizationId, current.mediaId, dto.keyword, id);
    const a = await this.prisma.automation.update({ where: { id }, data: dto });
    await this.audit.log({ action: "automation.update", organizationId, userId, entityType: "Automation", entityId: id, metadata: { fields: Object.keys(dto) } });
    return a;
  }

  async setStatus(organizationId: string, userId: string, id: string, status: "ACTIVE" | "PAUSED") {
    const current = await this.getOwned(organizationId, id);
    if (status === "ACTIVE") await this.assertNoKeywordConflict(organizationId, current.mediaId, current.keyword, id);
    const a = await this.prisma.automation.update({ where: { id }, data: { status } });
    await this.audit.log({ action: `automation.${status === "ACTIVE" ? "activate" : "pause"}`, organizationId, userId, entityType: "Automation", entityId: id });
    return a;
  }
}
