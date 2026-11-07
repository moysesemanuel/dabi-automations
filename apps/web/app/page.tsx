import { redirect } from "next/navigation";
import { apiGet } from "@/lib/api";
import type { Membership } from "@/lib/types";
import { logout } from "./actions";

export default async function Home() {
  const memberships = await apiGet<Membership[]>("/me");
  if (memberships.length > 0) redirect(`/o/${memberships[0].organization.id}`);
  return (
    <main className="auth">
      <div className="card auth-card">
        <h1>Sem organização</h1>
        <p className="muted">Sua conta ainda não faz parte de nenhuma organização. Peça acesso a quem administra a DaBi Automations.</p>
        <form action={logout}><button className="btn">Sair</button></form>
      </div>
    </main>
  );
}
