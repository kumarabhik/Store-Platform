// SQLite datetime('now') is UTC without a zone marker ("2026-10-10 05:30:00"); Date.parse would read it as local time.
export function parseDbTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isNaN(ms) ? null : ms;
}
