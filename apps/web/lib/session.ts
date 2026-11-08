import "server-only";
import { cookies, headers } from "next/headers";
import { shouldUseSecureCookie } from "./cookie-flags";

/** O JWT da API vive só neste cookie httpOnly: o JavaScript do navegador nunca o enxerga. */
export const SESSION_COOKIE = "dabi_session";
const MAX_AGE_SECONDS = 12 * 60 * 60; // igual à validade do JWT na API

export async function readToken() {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export async function createSession(token: string) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: shouldUseSecureCookie(process.env.NODE_ENV, (await headers()).get("x-forwarded-proto")),
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession() {
  (await cookies()).delete(SESSION_COOKIE);
}
