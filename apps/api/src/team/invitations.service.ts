import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import type { AcceptInvitationNewUserDto } from "@dabi/contracts";
import { PrismaService } from "../prisma/prisma.module";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { hashToken } from "./team.service";

const GONE = "Convite inválido ou expirado.";

@Injectable()
export class InvitationsService {
  constructor(private prisma: PrismaService, private audit: AuditService, private auth: AuthService) {}

  /** Convite utilizável: existe, não foi aceito/revogado e não expirou. Qualquer outro caso é o mesmo erro (nada vaza). */
  private async findValid(token: string) {
    if (!token || token.length < 20) throw new NotFoundException(GONE);
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) }, include: { organization: { select: { name: true } } } });
    if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt.getTime() <= Date.now()) throw new NotFoundException(GONE);
    return inv;
  }

  /** Dados mínimos para a tela de convite (público, só com o token). */
  async preview(token: string) {
    const inv = await this.findValid(token);
    const user = await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } });
    return { organizationName: inv.organization.name, email: inv.email, role: inv.role, accountExists: Boolean(user) };
  }

  /** Marca como aceito de forma atômica: só uma execução consegue (convite de uso único). */
  private async consume(id: string) {
    const r = await this.prisma.invitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException(GONE);
  }

  /** Pessoa sem conta: cria o usuário com o e-mail do convite e já entra. */
  async acceptNew(token: string, dto: AcceptInvitationNewUserDto) {
    const inv = await this.findValid(token);
    if (await this.prisma.user.findUnique({ where: { email: inv.email }, select: { id: true } })) {
      throw new ConflictException("Já existe uma conta com esse e-mail. Entre para aceitar o convite.");
    }
    const passwordHash = await bcrypt.hash(dto.password, 12);
    await this.consume(inv.id);
    const user = await this.prisma.user.create({ data: { email: inv.email, name: dto.name, passwordHash } });
    await this.prisma.membership.create({ data: { userId: user.id, organizationId: inv.organizationId, role: inv.role } });
    await this.audit.log({ action: "invitation.accept", organizationId: inv.organizationId, userId: user.id, entityType: "Invitation", entityId: inv.id });
    return { token: await this.auth.issueToken(user.id), organizationId: inv.organizationId };
  }

  /** Pessoa com conta: precisa estar logada COM O E-MAIL do convite. */
  async acceptExisting(token: string, userId: string) {
    const inv = await this.findValid(token);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
    if (!user || user.email.toLowerCase() !== inv.email) throw new ForbiddenException("Este convite é para outro e-mail. Entre com a conta convidada.");
    await this.consume(inv.id);
    await this.prisma.membership.upsert({
      where: { userId_organizationId: { userId, organizationId: inv.organizationId } },
      create: { userId, organizationId: inv.organizationId, role: inv.role },
      update: {},
    });
    await this.audit.log({ action: "invitation.accept", organizationId: inv.organizationId, userId, entityType: "Invitation", entityId: inv.id });
    return { organizationId: inv.organizationId };
  }
}
