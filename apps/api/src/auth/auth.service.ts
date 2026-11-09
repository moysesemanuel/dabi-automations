import { ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcryptjs";
import { loadEnv } from "@dabi/config";
import type { LoginDto, RegisterDto } from "@dabi/contracts";
import { PrismaService } from "../prisma/prisma.module";
import { AuditService } from "../audit/audit.service";
import { LoginThrottle } from "./login-throttle";
import { auditEmailMetadata } from "../security/hmac";

// hash real fictício: iguala o custo de bcrypt quando o e-mail não existe
const DUMMY_HASH = bcrypt.hashSync("dummy-password-for-timing", 12);

@Injectable()
export class AuthService {
  private env = loadEnv();
  constructor(private prisma: PrismaService, private jwt: JwtService, private audit: AuditService, private throttle: LoginThrottle) {}

  async register(dto: RegisterDto) {
    const users = await this.prisma.user.count();
    if (users > 0 && this.env.ALLOW_REGISTRATION !== "true") throw new ForbiddenException("Cadastro desabilitado");
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const { user, org } = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({ data: { email: dto.email, name: dto.name, passwordHash } });
      const org = await tx.organization.create({
        data: { name: dto.organizationName, memberships: { create: { userId: user.id, role: "OWNER" } } },
      });
      return { user, org };
    });
    await this.audit.log({ action: "user.register", userId: user.id, organizationId: org.id });
    return { token: await this.sign(user.id), organizationId: org.id };
  }

  async login(dto: LoginDto, ip?: string) {
    await this.throttle.assertAllowed(ip, dto.email); // 429 antes de gastar bcrypt
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      await this.throttle.recordFailure(ip, dto.email);
      // Sem e-mail em texto: só um HMAC com chave própria (AUDIT_HMAC_KEY); sem a chave (desenvolvimento), nenhum identificador.
      await this.audit.log({ action: "auth.login_failed", metadata: auditEmailMetadata(dto.email) });
      throw new UnauthorizedException("Credenciais inválidas");
    }
    await this.throttle.recordSuccess(ip, dto.email);
    await this.audit.log({ action: "auth.login", userId: user.id });
    return { token: await this.sign(user.id) };
  }

  /** Cadastro livre? (primeiro usuário do sistema ou ALLOW_REGISTRATION=true). */
  async registrationOpen() {
    return this.env.ALLOW_REGISTRATION === "true" || (await this.prisma.user.count()) === 0;
  }

  /** Emite o JWT de sessão para um usuário já validado (usado também ao aceitar convite). */
  issueToken(userId: string) { return this.sign(userId); }

  private sign(userId: string) {
    return this.jwt.signAsync({ sub: userId }, { secret: this.env.JWT_SECRET, expiresIn: "12h" });
  }
}
