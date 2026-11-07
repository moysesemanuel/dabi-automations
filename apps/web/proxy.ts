import { NextResponse, type NextRequest } from "next/server";

/**
 * Verificação otimista: só checa se há cookie de sessão. A autorização de verdade
 * (JWT, membership e papel) continua sendo da API em cada chamada.
 */
const PUBLIC = ["/login", "/session-expired", "/cadastro"];
// Convite: aberto, pois quem recebe ainda não tem conta/sessão. O token do link é a credencial.
const isPublic = (p: string) => PUBLIC.includes(p) || p.startsWith("/convite/");

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = req.cookies.has("dabi_session");
  if (!hasSession && !isPublic(pathname)) return NextResponse.redirect(new URL("/login", req.url));
  if (hasSession && (pathname === "/login" || pathname === "/cadastro")) return NextResponse.redirect(new URL("/", req.url));
  return NextResponse.next();
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webp)$).*)"] };
