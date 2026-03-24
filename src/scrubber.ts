/**
 * PII scrubber for Firebase MCP server.
 * Two-pass pattern matching existing scrubber_service.ts:
 *   Pass 1 — Field-name stripping: known PII fields → [REDACTED]
 *   Pass 2 — Regex fallback: email patterns on remaining strings → [EMAIL_REDACTED]
 */

/** Fields that contain PII and should be redacted. */
const PII_FIELDS = new Set([
  "userId",
  "uid",
  "createdBy",
  "email",
  "displayName",
  "phone",
  "ownerUid",
  "profileId",
  "owner_uid",
]);

/** Email regex — matches standard email patterns. */
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Scrub a Firestore document, returning a copy with PII removed.
 * Does NOT mutate the original object.
 */
export function scrubDocument(doc: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(doc)) {
    // Pass 1: Field-name stripping
    if (PII_FIELDS.has(key)) {
      result[key] = "[REDACTED]";
      continue;
    }

    // Recurse into nested objects
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = scrubDocument(value as Record<string, unknown>);
      continue;
    }

    // Recurse into arrays
    if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        item !== null && typeof item === "object"
          ? scrubDocument(item as Record<string, unknown>)
          : typeof item === "string"
            ? scrubString(item)
            : item
      );
      continue;
    }

    // Pass 2: Regex fallback on string values
    if (typeof value === "string") {
      result[key] = scrubString(value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

/** Scrub email patterns from a string value. */
function scrubString(value: string): string {
  return value.replace(EMAIL_REGEX, "[EMAIL_REDACTED]");
}
