export function initialLoadOnly(at = new Date()) {
  const localDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Caracas", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(at);
  return localDate < "2026-09-26";
}
