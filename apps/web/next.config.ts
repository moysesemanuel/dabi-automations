import { resolve } from "node:path";
import type { NextConfig } from "next";

// O `next dev` não lê o .env da raiz do monorepo: carrega aqui (não sobrescreve variáveis já definidas).
try { process.loadEnvFile(resolve(import.meta.dirname ?? __dirname, "../../.env")); } catch { /* sem .env: usa o ambiente */ }
const devHost = process.env.DEV_PUBLIC_HOST?.trim();

const config: NextConfig = {
  poweredByHeader: false,
  // Domínio HTTPS de desenvolvimento (túnel), configurável por ambiente: DEV_PUBLIC_HOST=dev.exemplo.com
  allowedDevOrigins: devHost ? [devHost] : [],
  // Server Actions comparam Origin x Host: com túnel/proxy o Host pode chegar diferente do Origin.
  ...(devHost ? { experimental: { serverActions: { allowedOrigins: [devHost] } } } : {}),
  // @dabi/contracts é TypeScript puro (sem build): o Next precisa compilá-lo.
  transpilePackages: ["@dabi/contracts"],
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      ],
    }];
  },
};
export default config;
