import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { loginSchema, registerSchema, type LoginDto, type RegisterDto } from "@dabi/contracts";
import { AuthService } from "./auth.service";
import { ZodPipe } from "./zod.pipe";

@Controller("auth")
export class AuthController {
  constructor(private auth: AuthService) {}

  @Post("register")
  register(@Body(new ZodPipe(registerSchema)) dto: RegisterDto) { return this.auth.register(dto); }

  @Post("login") @HttpCode(200)
  login(@Body(new ZodPipe(loginSchema)) dto: LoginDto) { return this.auth.login(dto); }
}
