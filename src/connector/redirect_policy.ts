/**
 * OH-1 redirect policy, VENDORED from wayfinder `functions/src/mcp/redirect_policy.ts`
 * (Pelaris 1.4 B2a lane C, C6 a). The two copies are pinned to one case table,
 * `test_fixtures/redirect_policy_cases.json`, whose canonical digest both
 * repos hold (`REDIRECT_POLICY_CASES_SHA256`); wayfinder's
 * `tools/check_gateway_contract_drift.mjs` compares them. It is run by hand at
 * every release (this repo's CI cannot read wayfinder).
 *
 * The rule: `https:` on any host; `http:` only on `localhost`, `127.0.0.1` or
 * `[::1]`; script and file schemes refused outright; any other scheme only
 * when the admin dial `system/oauth_redirect_policy.custom_schemes` lists it
 * (never `http:`, `https:`, `intent:`, `about:`, `chrome:` or a refused
 * scheme); unparseable, empty, holding a space or control character, or over
 * 2,048 characters refused. A registration holds at most 10 URIs.
 */

/** C9's refused hand-back schemes (wayfinder `oauth_handback.ts` REFUSED_HANDBACK_SCHEMES). */
export const REFUSED_SCHEMES: readonly string[] = Object.freeze([
  "javascript:", "data:", "vbscript:", "file:", "blob:", "filesystem:",
]);

export const OAUTH_REDIRECT_POLICY_DOC = "system/oauth_redirect_policy";
export const MAX_REDIRECT_URI_LENGTH = 2048;
export const MAX_REDIRECT_URIS = 10;
export const MAX_CUSTOM_SCHEMES = 10;
export const CUSTOM_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:$/;
export const NEVER_LISTABLE_SCHEMES: readonly string[] = Object.freeze([
  "http:", "https:", "intent:", "about:", "chrome:",
  "ftp:", "ws:", "wss:", "view-source:", "jar:", "mailto:", "tel:", "sms:",
  "googlechrome:", "googlechromes:", "microsoft-edge:", "x-safari-https:", "firefox:", "opera-http:",
  ...REFUSED_SCHEMES,
]);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
// eslint-disable-next-line no-control-regex
const CONTROL_OR_SPACE = /[\u0000-\u0020\u007f]/;

export type RedirectRefusal =
  | "unparseable"
  | "too_long"
  | "refused_scheme"
  | "http_not_loopback"
  | "custom_scheme_not_listed";

export type RedirectVerdict =
  | { ok: true; kind: "https" | "loopback_http" | "custom_scheme"; scheme: string; host: string }
  | { ok: false; reason: RedirectRefusal; scheme: string | null };

export interface RedirectPolicy {
  customSchemes: readonly string[];
}

export const DEFAULT_REDIRECT_POLICY: RedirectPolicy = Object.freeze({ customSchemes: Object.freeze([]) as readonly string[] });

export function isListableCustomScheme(value: unknown): value is string {
  return typeof value === "string" &&
    CUSTOM_SCHEME_PATTERN.test(value) &&
    !NEVER_LISTABLE_SCHEMES.includes(value);
}

export function classifyRedirectUri(uri: unknown, policy: RedirectPolicy): RedirectVerdict {
  if (typeof uri !== "string" || uri.length === 0) return { ok: false, reason: "unparseable", scheme: null };
  if (uri.length > MAX_REDIRECT_URI_LENGTH) return { ok: false, reason: "too_long", scheme: null };
  if (CONTROL_OR_SPACE.test(uri)) return { ok: false, reason: "unparseable", scheme: null };
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return { ok: false, reason: "unparseable", scheme: null };
  }
  const scheme = url.protocol.toLowerCase();
  if (REFUSED_SCHEMES.includes(scheme)) return { ok: false, reason: "refused_scheme", scheme };
  const host = url.hostname.toLowerCase();
  if (scheme === "https:") {
    if (host === "") return { ok: false, reason: "unparseable", scheme };
    return { ok: true, kind: "https", scheme, host };
  }
  if (scheme === "http:") {
    return LOOPBACK_HOSTS.has(host) ?
      { ok: true, kind: "loopback_http", scheme, host } :
      { ok: false, reason: "http_not_loopback", scheme };
  }
  if (NEVER_LISTABLE_SCHEMES.includes(scheme)) return { ok: false, reason: "refused_scheme", scheme };
  const listed = policy.customSchemes.some((s) => isListableCustomScheme(s) && s === scheme);
  return listed ?
    { ok: true, kind: "custom_scheme", scheme, host } :
    { ok: false, reason: "custom_scheme_not_listed", scheme };
}

export type RedirectListVerdict =
  | { ok: true; uris: string[] }
  | { ok: false; reason: "missing" | "too_many" | RedirectRefusal; index: number | null; scheme: string | null };

export function classifyRedirectUris(uris: unknown, policy: RedirectPolicy): RedirectListVerdict {
  if (!Array.isArray(uris) || uris.length === 0) return { ok: false, reason: "missing", index: null, scheme: null };
  if (uris.length > MAX_REDIRECT_URIS) return { ok: false, reason: "too_many", index: null, scheme: null };
  for (let i = 0; i < uris.length; i++) {
    const verdict = classifyRedirectUri(uris[i], policy);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, index: i, scheme: verdict.scheme };
  }
  return { ok: true, uris: uris as string[] };
}

export function parseRedirectPolicy(
  doc: Readonly<Record<string, unknown>> | null | undefined,
): { policy: RedirectPolicy; dropped: string[] } {
  const raw = doc?.custom_schemes;
  if (!Array.isArray(raw)) return { policy: DEFAULT_REDIRECT_POLICY, dropped: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const entry of raw) {
    if (isListableCustomScheme(entry) && !kept.includes(entry) && kept.length < MAX_CUSTOM_SCHEMES) {
      kept.push(entry);
    } else {
      dropped.push(typeof entry === "string" ? entry.slice(0, 40) : typeof entry);
    }
  }
  return { policy: Object.freeze({ customSchemes: Object.freeze(kept) }), dropped };
}

/** Canonical SHA-256 of `test_fixtures/redirect_policy_cases.json` (equal to wayfinder's). */
export const REDIRECT_POLICY_CASES_SHA256 = "ae63a794490f2dad0f970a693c5cfbaf5e2dafe854c1cd4470ecacfc4ebb6a39";
