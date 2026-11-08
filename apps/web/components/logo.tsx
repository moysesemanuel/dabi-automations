/**
 * Logo aprovada do DaBiChat (arquivos em /public/brand, sem alteração).
 * Tema claro: versão colorida. Tema escuro: versão branca (a colorida tem trecho cinza-escuro sem contraste no escuro).
 * A troca é feita por CSS (ver .logo-light/.logo-dark em globals.css), então vale também para o tema fixado em Aparência.
 */
export function Logo({ height = 32 }: { height?: number }) {
  const width = Math.round(height * 3.475); // proporção original da logo (23369 x 6725)
  return (
    <span className="logo">
      <img className="logo-light" src="/brand/dabichat-color.svg" alt="DaBiChat" width={width} height={height} />
      <img className="logo-dark" src="/brand/dabichat-white.svg" alt="" aria-hidden="true" width={width} height={height} />
    </span>
  );
}
