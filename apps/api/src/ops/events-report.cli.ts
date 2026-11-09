// Uso: pnpm --filter @dabi/api ops:events -- --kind needs_review|dropped|no_org|all [--since 24h|7d|2026-11-09] [--limit 50] [--org <organizationId>]
// Saída: uma linha JSON por evento (IDs internos, estado, código de razão, datas). Sem dados do comentário.
import "reflect-metadata";
import { PrismaClient } from "@dabi/database";
import { parseSince, queryOperatorEvents, type OpsKind } from "./events-report";

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
const kinds: OpsKind[] = ["needs_review", "dropped", "no_org", "all"];

(async () => {
  const kind = (arg("kind") ?? "all") as OpsKind;
  if (!kinds.includes(kind)) { console.error(`--kind inválido (use: ${kinds.join(", ")})`); process.exit(2); }
  if (kind === "no_org" && arg("org")) { console.error("--kind no_org não pode ser combinado com --org"); process.exit(2); }
  const prisma = new PrismaClient();
  try {
    const rows = await queryOperatorEvents(prisma, { kind, since: parseSince(arg("since")), limit: arg("limit") ? Number(arg("limit")) : undefined, organizationId: arg("org") });
    for (const r of rows) console.log(JSON.stringify(r));
    console.error(`# ${rows.length} evento(s) | kind=${kind}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error("falhou:", String(e?.message ?? e).split("\n")[0]); process.exit(1); });
