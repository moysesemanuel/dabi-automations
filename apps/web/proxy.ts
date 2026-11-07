import { NextResponse, type NextRequest } from "next/server";

/**
 * Verificação otimista: só checa se há cookie de sessão. A autorização de verdade
 * (JWT, membership e papel) continua sendo da API em cada chamada.
 */
const PUBLIC = ["/login", "/session-expired"];

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has("dabi_session");
  const isPublic = PUBLIC.some((p) => pathname === p);
  if (!hasSession && !isPublic) return NextResponse.redirect(new URL("/login", req.url));
  if (hasSession && pathname === "/login") return NextResponse.redirect(new URL("/", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"] };
