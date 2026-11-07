import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { loadEnv } from "@dabi/config";
import { PrismaService } from "../prisma/prisma.module";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private secret = loadEnv().JWT_SECRET;
  constructor(private jwt: JwtService, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? "").split(" ");
    if (type !== "Bearer" || !token) throw new UnauthorizedException();
    try {
      const p = await this.jwt.verifyAsync(token, { secret: this.secret });
      // O token vale 12h, mas a conta pode ter sido removida nesse intervalo: confere que o usuário ainda existe.
      const user = await this.prisma.user.findUnique({ where: { id: p.sub as string }, select: { id: true } });
      if (!user) throw new UnauthorizedException();
      req.user = { id: user.id };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
