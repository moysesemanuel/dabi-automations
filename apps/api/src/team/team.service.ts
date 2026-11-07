import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { INVITATION_TTL_DAYS, type CreateInvitationDto, type GrantableRole } from "@dabi/contracts";
import type { Role } from "@dabi/database";
import { PrismaService } from "../prisma/prisma.module";
import { AuditService } from "../audit/audit.service";

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export interface Actor { userId: string; role: Role }

@Injectable()
export class TeamService {
  constructor(private prisma: PrismaService, private audit: AuditService) {}

  async members(organizationId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { organizationId },
      select: { role: true, user: { select: { id: true, email: true, name: true } } },
      orderBy: { id: "asc" },
    });
    return rows.map((m) => ({ userId: m.user.id, email: m.user.email, name: m.user.name, role: m.role }));
  }

  async invitations(organizationId: string) {
    const rows = await this.prisma.invitation.findMany({
      where: { organizationId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    const now = Date.now();
    return rows.map((r) => ({ ...r, expired: r.expiresAt.getTime() <= now }));
  }

  /** O token em texto é devolvido UMA vez; no banco fica só o hash. */
  async invite(organizationId: string, actor: Actor, dto: CreateInvitationDto) {
    const email = dto.email.toLowerCase();
    const existing = await this.prisma.membership.findFirst({ where: { organizationId, user: { email } }, select: { id: true } });
    if (existing) throw new ConflictException("Essa pessoa já faz parte da organização.");
    // Novo convite para o mesmo e-mail invalida os anteriores (só o link mais recente vale).
    await this.prisma.invitation.updateMany({ where: { organizationId, email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000);
    const inv = await this.prisma.invitation.create({
      data: { organizationId, email, role: dto.role, tokenHash: hashToken(token), invitedById: actor.userId, expiresAt },
    });
    await this.audit.log({ action: "invitation.create", organizationId, userId: actor.userId, entityType: "Invitation", entityId: inv.id, metadata: { role: dto.role } });
    return { id: inv.id, email, role: dto.role, expiresAt, token };
  }

  async revoke(organizationId: string, actor: Actor, id: string) {
    // Filtra por organização: convite de outra org é "não encontrado".
    const r = await this.prisma.invitation.updateMany({ where: { id, organizationId, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    if (r.count !== 1) throw new NotFoundException("Convite não encontrado.");
    await this.audit.log({ action: "invitation.revoke", organizationId, userId: actor.userId, entityType: "Invitation", entityId: id });
    return { ok: true };
  }

  private async getMember(organizationId: string, userId: string) {
    const m = await this.prisma.membership.findUnique({ where: { userId_organizationId: { userId, organizationId } } });
    if (!m) throw new NotFoundException("Pessoa não encontrada nesta organização.");
    return m;
  }

  private async assertNotLastOwner(organizationId: string, target: { role: Role }) {
    if (target.role !== "OWNER") return;
    const owners = await this.prisma.membership.count({ where: { organizationId, role: "OWNER" } });
    if (owners <= 1) throw new BadRequestException("A organização precisa ter pelo menos um proprietário.");
  }

  /** OWNER remove qualquer pessoa (menos o último proprietário); ADMIN só remove MEMBER; qualquer um pode sair. */
  async remove(organizationId: string, actor: Actor, userId: string) {
    const target = await this.getMember(organizationId, userId);
    const self = actor.userId === userId;
    if (!self && actor.role !== "OWNER" && target.role !== "MEMBER") throw new ForbiddenException("Você só pode remover membros comuns.");
    await this.assertNotLastOwner(organizationId, target);
    await this.prisma.membership.delete({ where: { userId_organizationId: { userId, organizationId } } });
    await this.audit.log({ action: self ? "member.leave" : "member.remove", organizationId, userId: actor.userId, entityType: "User", entityId: userId });
    return { ok: true };
  }

  /** Só o proprietário muda papéis, e nunca o de outro proprietário (sem transferência nesta versão). */
  async changeRole(organizationId: string, actor: Actor, userId: string, role: GrantableRole) {
    if (actor.role !== "OWNER") throw new ForbiddenException();
    const target = await this.getMember(organizationId, userId);
    if (target.role === "OWNER") throw new BadRequestException("O papel de proprietário não pode ser alterado aqui.");
    const m = await this.prisma.membership.update({ where: { userId_organizationId: { userId, organizationId } }, data: { role } });
    await this.audit.log({ action: "member.role_change", organizationId, userId: actor.userId, entityType: "User", entityId: userId, metadata: { role } });
    return { userId, role: m.role };
  }
}
