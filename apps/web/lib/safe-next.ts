/** Só aceita voltar para a tela de convite (caminho relativo, sem "//" nem esquema): evita redirecionamento aberto. */
export function safeNext(next: string | undefined | null): string | null {
  return next && /^\/convite\/[A-Za-z0-9_-]{20,}$/.test(next) ? next : null;
}
