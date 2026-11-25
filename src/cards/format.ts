/**
 * Shared server-side formatting and guards for card mappers.
 *
 * Dates are calendar days ("YYYY-MM-DD"), worked in UTC so the server's time zone never
 * moves a day. Names are fixed English short names, never the locale's. Weeks run Monday
 * to Sunday. A card's labels are made here, on the server, so a page never formats a date.
 */

export type Raw = Record<string, unknown>;

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** The calendar day a value starts with ("2026-11-26T08:00:00Z" gives "2026-11-26"), or null when it is not a real day. */
export function dayKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A day key as a UTC midnight date. */
export function toDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** The day key `n` days after `key` (or before, for a negative `n`). */
export function addDays(key: string, n: number): string {
  const d = toDate(key);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday on or before a day (weeks run Monday to Sunday). */
export function mondayOf(key: string): string {
  const dow = toDate(key).getUTCDay();
  return addDays(key, dow === 0 ? -6 : 1 - dow);
}

/** "2026-11-26" to "Thu 26 Nov". */
export function shortDateLabel(key: string): string {
  const d = toDate(key);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Any value starting with a real calendar day, as "Thu 26 Nov"; otherwise null. */
export function dateLabelOf(value: unknown): string | null {
  const key = dayKey(value);
  return key ? shortDateLabel(key) : null;
}

/** A trimmed, non-empty string, or null. */
export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** A plain object (not an array), or null. */
export function obj(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : null;
}

/** The plain objects in an array; anything else gives an empty list. */
export function records(value: unknown): Raw[] {
  return Array.isArray(value)
    ? value.filter((v): v is Raw => v !== null && typeof v === "object" && !Array.isArray(v))
    : [];
}
