/**
 * PII scrubber for Firebase MCP server.
 * Two-pass pattern matching existing scrubber_service.ts:
 *   Pass 1 — Field-name stripping: known PII fields → [REDACTED]
 *   Pass 2 — Regex fallback: email patterns on remaining strings → [EMAIL_REDACTED]
 */
/**
 * Scrub a Firestore document, returning a copy with PII removed.
 * Does NOT mutate the original object.
 */
export declare function scrubDocument(doc: Record<string, unknown>): Record<string, unknown>;
