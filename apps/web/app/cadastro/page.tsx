import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { registrationOpen } from "@/lib/api";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = { title: "Criar conta" };

export default async function RegisterPage() {
  if (!(await registrationOpen())) redirect("/login");
  return (
    <main className="auth">
      <div className="card auth-card">
        <div className="brand"><span className="brand-mark" aria-hidden="true">D</span> DaBi Automations</div>
        <div>
          <h1>Criar conta</h1>
          <p className="muted">Você será o proprietário da organização e poderá convidar outras pessoas depois.</p>
        </div>
        <RegisterForm />
        <p className="muted">Já tem conta? <Link href="/login">Entrar</Link></p>
      </div>
    </main>
  );
}
