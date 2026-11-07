"use client";

export default function OrgError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card empty" role="alert">
      <h2>Algo deu errado</h2>
      <p>Não foi possível carregar esta página. Tente novamente em instantes.</p>
      <button className="btn primary" onClick={reset}>Tentar de novo</button>
    </div>
  );
}
