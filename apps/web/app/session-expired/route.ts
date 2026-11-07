import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/** Sessão recusada pela API (token vencido/inválido): limpa o cookie e volta ao login. */
export function GET(req: Request) {
  const res = NextResponse.redirect(new URL("/login?expired=1", req.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
