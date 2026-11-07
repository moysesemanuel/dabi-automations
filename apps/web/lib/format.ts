const TZ = "America/Sao_Paulo";
export const formatDateTime = (iso: string) =>
  new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: TZ }).format(new Date(iso));
export const formatDate = (iso: string) => new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium", timeZone: TZ }).format(new Date(iso));
