import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { PrismaClient } from "@dabi/database";
import { loadEnv } from "@dabi/config";
import { ConnectError, connectInstagramAccount } from "../instagram/instagram-connect";

/** Lê o token sem ecoar no terminal (ou de IG_ACCESS_TOKEN). Nunca vai para argv/histórico. */
function readSecret(prompt: string): Promise<string> {
  if (process.env.IG_ACCESS_TOKEN) return Promise.resolve(process.env.IG_ACCESS_TOKEN.trim());
  process.stdout.write(prompt);
  const muted = new Writable({ write: (_c, _e, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  return new Promise((resolve) => rl.question("", (a) => { rl.close(); process.stdout.write("\n"); resolve(a.trim()); }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift(); // o pnpm repassa o "--" literal
  const { values } = parseArgs({
    args: argv,
    options: {
      org: { type: "string" },
      "account-id": { type: "string" },
      username: { type: "string" },
      "expires-in-days": { type: "string" },
      login: { type: "string" },
    },
  });
  if (!values.org || !values["account-id"] || !values.username) {
    console.error("Uso: pnpm ig:connect --org <id|nome> --account-id <id> --username <usuario> [--login instagram|facebook] [--expires-in-days 60]\nToken: prompt oculto (ou variável IG_ACCESS_TOKEN).");
    process.exit(2);
  }
  const env = loadEnv();
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organization.findMany({ where: { OR: [{ id: values.org }, { name: values.org }] }, take: 2 });
    if (orgs.length !== 1) throw new ConnectError(orgs.length ? "Nome de organização ambíguo; use o id." : "Organização não encontrada (cadastre-se primeiro via POST /auth/register).");

    const login = (values.login ?? "instagram").toLowerCase();
    if (login !== "instagram" && login !== "facebook") throw new ConnectError("--login deve ser instagram ou facebook.");

    const accessToken = await readSecret("Access token do Instagram (oculto): ");
    if (!accessToken) throw new ConnectError("Token vazio.");
    const days = values["expires-in-days"] ? Number(values["expires-in-days"]) : null;

    const r = await connectInstagramAccount(
      { prisma, tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY, graphVersion: env.META_GRAPH_VERSION },
      {
        organizationId: orgs[0].id,
        providerAccountId: values["account-id"],
        username: values.username,
        accessToken,
        loginMode: login === "facebook" ? "FACEBOOK" : "INSTAGRAM",
        expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null,
      },
    );
    console.log(`${r.reconnected ? "Reconectada" : "Conectada"}: @${r.username} (socialAccountId=${r.id}) na organização "${orgs[0].name}".`);
  } catch (e) {
    console.error(e instanceof ConnectError ? `Erro: ${e.message}` : "Erro inesperado ao conectar a conta.");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
main();
