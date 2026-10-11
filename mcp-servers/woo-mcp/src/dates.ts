// "Today" means today in the store's timezone, not UTC and not the caller's (SYSTEM.md G8).

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(value: string): boolean {
  return DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

// Calendar date (YYYY-MM-DD) of `now` in an IANA timezone such as Asia/Kolkata.
export function todayIn(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function shiftDay(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// WooCommerce `after`/`before` are exclusive and, without dates_are_gmt, in store-local time.
// So one calendar day is (previous day 23:59:59, next day 00:00:00).
export function dayRange(day: string): { after: string; before: string } {
  return { after: `${shiftDay(day, -1)}T23:59:59`, before: `${shiftDay(day, 1)}T00:00:00` };
}
