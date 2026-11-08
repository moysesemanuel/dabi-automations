import type { NextRequest } from "next/server";
import { api } from "@/lib/api";

// O retorno da Meta é sempre dinâmico e nunca pode ser cacheado.
export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["connected", "partial", "already_connected", "other_organization", "cancelled", "expired", "forbidden", "insufficient_permissions", "no_accounts", "error"]);

/** Redirecionamento relativo (sem depender do host/túnel); sem code/state na URL de destino. */
const back = (to: string) => new Response(null, { status: 303, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });

/**
 * Retorno do Unified Login da Meta. Exige sessão (sem ela, a lib/api manda para /login).
 * O code e o state só são repassados à API (servidor a servidor); nada disso vai para o navegador.
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const state = p.get("state");
  if (!state) return back("/?ig=error");
  const r = await api<{ outcome: string; organizationId?: string }>("/instagram/oauth/complete", {
    method: "POST",
    body: { state, code: p.get("code") ?? undefined, error: p.get("error") ?? undefined, errorReason: p.get("error_reason") ?? undefined },
  });
  if (!r.ok) return back(r.status === 503 ? "/?ig=unavailable" : r.status === 400 ? "/?ig=error" : "/?ig=forbidden");
  const outcome = OUTCOMES.has(r.data.outcome) ? r.data.outcome : "error";
  return back(r.data.organizationId ? `/o/${encodeURIComponent(r.data.organizationId)}/conectar?ig=${outcome}` : `/?ig=${outcome}`);
}
