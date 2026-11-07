import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { loadEnv } from "@dabi/config";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private secret = loadEnv().JWT_SECRET;
  constructor(private jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const [type, token] = (req.headers.authorization ?? "").split(" ");
    if (type !== "Bearer" || !token) throw new UnauthorizedException();
    try {
      const p = await this.jwt.verifyAsync(token, { secret: this.secret });
      req.user = { id: p.sub as string };
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}
