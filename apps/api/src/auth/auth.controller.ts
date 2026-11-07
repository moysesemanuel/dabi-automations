import { Body, Controller, Get, HttpCode, Post, Req } from "@nestjs/common";
import { loginSchema, registerSchema, type LoginDto, type RegisterDto } from "@dabi/contracts";
import { AuthService } from "./auth.service";
import { ZodPipe } from "./zod.pipe";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  /** Para a tela decidir se mostra "Criar conta". */
  @Get("status") async status() { return { registrationOpen: await this.auth.registrationOpen() }; }

  @Post("register")
  register(@Body(new ZodPipe(registerSchema)) dto: RegisterDto) { return this.auth.register(dto); }

  @Post("login") @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) dto: LoginDto, @Req() req: any) { return this.auth.login(dto, req.ip); }
}
