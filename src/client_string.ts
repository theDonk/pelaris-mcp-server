/**
 * The one cleaner for a client-controlled string (a registered client name, MCP `clientInfo`,
 * a request header) before it is stored, shown or logged. Mirrors wayfinder lane A
 * `consent_page.ts` `normaliseClientName`: Unicode control (Cc) and format (Cf: bidi marks,
 * overrides, isolates, zero-width) characters and line or paragraph separators become spaces,
 * whitespace collapses, the result is trimmed and capped at `maxChars` code points. Null when
 * nothing is left. Reuse audit 29/10/2026: the protocol log used to hand-roll a narrower copy.
 */
export function normaliseClientString(raw: unknown, maxChars: number): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, maxChars).join("").trim();
}
