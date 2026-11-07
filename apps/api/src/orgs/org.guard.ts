import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@dabi/database";
import { PrismaService } from "../prisma/prisma.module";

export const Roles = (...roles: Role[]) => SetMetadata("roles", roles);

/**
 * Garante que o usuário autenticado é membro da organização em :orgId.
 * Use SEMPRE depois do JwtAuthGuard. Não-membro recebe 403 sem revelar se a org existe.
 * Todo acesso a dados deve filtrar por req.membership.organizationId, nunca pelo id do corpo.
 */
@Injectable()
export class OrgGuard implements CanActivate {
  constructor(private prisma: PrismaService, private reflector: Reflector) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const orgId = req.params?.orgId;
    if (!req.user?.id || !orgId) throw new ForbiddenException();
    const m = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: req.user.id, organizationId: orgId } },
    });
    if (!m) throw new ForbiddenException();
    const roles = this.reflector.get<Role[] | undefined>("roles", ctx.getHandler());
    if (roles?.length && !roles.includes(m.role)) throw new ForbiddenException();
    req.membership = m;
    return true;
  }
}
