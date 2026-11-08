"use client";
import { useEffect, useRef, useState } from "react";

type Scheme = "system" | "light" | "dark";
const OPTIONS: { value: Scheme; label: string }[] = [
  { value: "system", label: "Automático (segue o seu dispositivo)" },
  { value: "light", label: "Claro" },
  { value: "dark", label: "Escuro" },
];

const read = (): Scheme => {
  try { const v = localStorage.getItem("color-scheme"); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
};
const apply = (s: Scheme) => {
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (meta) meta.setAttribute("content", s === "system" ? "light dark" : s);
  if (s === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = s; // usado para trocar a logo
};

export function ThemeDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const [scheme, setScheme] = useState<Scheme>("system");

  useEffect(() => {
    setScheme(read());
    // Mantém abas sincronizadas.
    const onStorage = (e: StorageEvent) => { if (e.key === "color-scheme") { const s = read(); setScheme(s); apply(s); } };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const choose = (s: Scheme) => {
    setScheme(s);
    apply(s);
    try { s === "system" ? localStorage.removeItem("color-scheme") : localStorage.setItem("color-scheme", s); } catch { /* sem armazenamento: vale só nesta página */ }
  };

  return (
    <>
      <button type="button" className="btn ghost small" onClick={() => ref.current?.showModal()}>Aparência</button>
      <dialog ref={ref} aria-labelledby="theme-title">
        <div className="dialog-body">
          <h2 id="theme-title">Aparência</h2>
          <fieldset>
            <legend>Tema</legend>
            {OPTIONS.map((o) => (
              <label key={o.value} className="check">
                <input type="radio" name="scheme" value={o.value} checked={scheme === o.value} onChange={() => choose(o.value)} autoFocus={o.value === scheme} />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
          <form method="dialog" className="actions"><button className="btn primary">Pronto</button></form>
        </div>
      </dialog>
    </>
  );
}
