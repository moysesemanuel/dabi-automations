"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";

const icons: Record<string, string> = {
  home: "M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0",
  image: "M4 5h16v14H4zm3 10l3-4 3 3 2-2 3 3",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
};

export function Nav({ orgId }: { orgId: string }) {
  const path = usePathname();
  const base = `/o/${orgId}`;
  const items = [
    { href: base, label: "Visão geral", icon: "home", exact: true },
    { href: `${base}/contas`, label: "Contas", icon: "user" },
    { href: `${base}/publicacoes`, label: "Publicações", icon: "image" },
    { href: `${base}/automacoes`, label: "Automações", icon: "bolt" },
    { href: `${base}/historico`, label: "Histórico", icon: "list" },
  ];
  return (
    <nav className="nav" aria-label="Principal">
      {items.map((i) => {
        const active = i.exact ? path === i.href : path.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[i.icon]} /></svg>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
