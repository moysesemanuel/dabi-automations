import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = { title: { default: "DaBiChat", template: "%s · DaBiChat" }, description: "Automações para o seu Instagram.", icons: { icon: [{ url: "/brand/favicon-color.svg", type: "image/svg+xml" }] } };

// Aplica a preferência salva ANTES da pintura (evita piscar). O sistema é o padrão.
const THEME_BOOT = `try{var t=localStorage.getItem("color-scheme");if(t==="light"||t==="dark")document.querySelector('meta[name="color-scheme"]').content=t;document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" suppressHydrationWarning />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
