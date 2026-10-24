/**
 * The gateway's client-registration guard (Pelaris 1.4 B2a lane C, C6 a;
 * FL-3 OH-1; panel P1-02, P4-12, P4-13, P5-3, P5-10, P2-14).
 *
 * What `/register` checks:
 *   - every redirect URI passes the vendored redirect policy (with the shared
 *     `custom_schemes` dial), at most 10 URIs of 2,048 characters;
 *   - a refusal prints the closed `dcr_refused` line (the same shape as the
 *     function's registrar, `registrar: "gateway"`) and, when the refused
 *     URI's host is a mapped assistant, raises the shared once-a-day
 *     `admin_alerts/connector_dcr_refused_<UTC day>` (wayfinder
 *     `mcp/dcr_refusal_alert.ts`, vendored here);
 *   - the registered name is normalised as lane A's `normaliseClientName`
 *     (Cc, Cf and line or paragraph separators removed, whitespace collapsed,
 *     capped at 64);
 *   - the shared `dcr_per_hour` limit counts only NEW registrations (after
 *     the idempotent lookup misses), keyed on the client address, and REFUSES
 *     past the limit in every mode, as the function's registrar does (B2a fix
 *     pass, SR-5 = CR-7). `create_limit_mode` belongs to the profile-create
 *     limit only.
 */
import { Timestamp, type Firestore } from "firebase-admin/firestore";

import { CUSTOM_SCHEME_PATTERN, type RedirectRefusal } from "./redirect_policy.js";

export const CLIENT_NAME_MAX_CHARS = 64;

/** Mirrors wayfinder lane A `consent_page.ts` `normaliseClientName`. */
export function normaliseClientName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, CLIENT_NAME_MAX_CHARS).join("").trim();
}

/** C9's mapped assistant hosts (wayfinder `oauth_handback.ts` HOST_LABELS keys). */
export const MAPPED_ASSISTANT_HOSTS: ReadonlySet<string> = new Set(["chat.openai.com", "chatgpt.com", "claude.ai", "claude.com"]);

export type DcrRefusedReason = RedirectRefusal | "too_many" | "missing";

export interface DcrRefusedLine {
  event: "dcr_refused";
  registrar: "function" | "gateway";
  reason: DcrRefusedReason;
  scheme: string | null;
  assistant_host: boolean;
}

export const DCR_REFUSED_LINE_KEYS: readonly string[] = Object.freeze(["event", "registrar", "reason", "scheme", "assistant_host"]);

export function dcrSchemeLabel(scheme: string | null | undefined): string | null {
  if (scheme === null || scheme === undefined || scheme === "") return null;
  return scheme.length <= 32 && CUSTOM_SCHEME_PATTERN.test(scheme) ? scheme : "other";
}

export function uriNamesAssistantHost(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  try {
    const host = new URL(uri).hostname.toLowerCase();
    return host !== "" && MAPPED_ASSISTANT_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function dcrRefusedLine(input: {
  reason: DcrRefusedReason;
  scheme: string | null | undefined;
  refusedUri: unknown;
}): DcrRefusedLine {
  return {
    event: "dcr_refused",
    registrar: "gateway",
    reason: input.reason,
    scheme: dcrSchemeLabel(input.scheme),
    assistant_host: uriNamesAssistantHost(input.refusedUri),
  };
}

export const CONNECTOR_DCR_REFUSED_CATEGORY = "connector_dcr_refused";

export function dcrRefusedAlertDocId(now: Date): string {
  return `${CONNECTOR_DCR_REFUSED_CATEGORY}_${now.toISOString().slice(0, 10)}`;
}

let raisedDay: string | null = null;

/**
 * Vendored `raiseConnectorDcrRefusedAlertOnce`: the same doc id and shape as
 * the function's (wayfinder `buildAdminAlertData`), so the two registrars
 * share one alert a day. Never throws.
 */
export async function raiseConnectorDcrRefusedAlertOnce(
  db: Pick<Firestore, "collection">,
  line: DcrRefusedLine,
  now: Date = new Date(),
): Promise<boolean> {
  if (!line.assistant_host) return false;
  const day = now.toISOString().slice(0, 10);
  if (raisedDay === day) return false;
  raisedDay = day;
  try {
    await db.collection("admin_alerts").doc(dcrRefusedAlertDocId(now)).create({
      severity: "warn",
      category: CONNECTOR_DCR_REFUSED_CATEGORY,
      details: {
        registrar: line.registrar,
        reason: line.reason,
        scheme: line.scheme,
        note: "A client registration naming ChatGPT or Claude was refused by the redirect policy. Anyone can " +
          "send a registration, so this alone is never a reason to list a scheme. List one in " +
          "system/oauth_redirect_policy.custom_schemes only after the assistant's own published docs name it " +
          "and many refusals share it. Check dcr_refused lines for both registrars.",
      },
      resolved_at: null,
      resolved_by_uid: null,
      created_at: Timestamp.fromDate(now),
    });
    return true;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== 6) {
      raisedDay = null;
      console.warn(JSON.stringify({
        event: "connector_dcr_refused_alert_failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    return false;
  }
}

export function __resetDcrRefusedAlertForTest(): void {
  raisedDay = null;
}
