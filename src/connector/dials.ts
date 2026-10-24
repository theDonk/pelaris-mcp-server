/**
 * The admin dials the gateway reads (Pelaris 1.4 B2a lane C, C6). Same docs,
 * field names, defaults and bounds as wayfinder's readers, so one admin
 * change steers both sides:
 *   - `system/connector_signup_controls` (wayfinder lane B,
 *     `account/connector_signup_controls.ts`): `dcr_per_hour` 10 (1 to 100),
 *     `client_ip_hop` `first` | `right_most`, `create_limit_mode`
 *     `log_only` | `enforce`;
 *   - `system/oauth_redirect_policy.custom_schemes` (C1, `redirect_policy.ts`);
 *   - `system_config/jit_controls` (B1R, `services/jit_controls.ts`):
 *     `connector_use_stamp_minutes` 60 (1 to 1440),
 *     `bridge_return_step_timeout_ms` 10000 (250 to 30000).
 * Read at most once a minute; a failed read keeps the last good value, else
 * the defaults. Never throws. Bounds are checked against wayfinder by
 * `tools/check_gateway_contract_drift.mjs` there.
 */
import { DEFAULT_REDIRECT_POLICY, OAUTH_REDIRECT_POLICY_DOC, parseRedirectPolicy, type RedirectPolicy } from "./redirect_policy.js";

export const CONNECTOR_SIGNUP_CONTROLS_DOC = "system/connector_signup_controls";
export const JIT_CONTROLS_DOC = "system_config/jit_controls";

export type ClientIpHop = "first" | "right_most";
export type CreateLimitMode = "log_only" | "enforce";

export interface GatewayDials {
  dcrPerHour: number;
  clientIpHop: ClientIpHop;
  /** Read for completeness; the gateway no longer uses it (SR-5: the DCR limit refuses in every mode). */
  createLimitMode: CreateLimitMode;
  connectorUseStampMinutes: number;
  bridgeReturnStepTimeoutMs: number;
  redirectPolicy: RedirectPolicy;
}

interface NumberDial { fallback: number; floor: number; ceiling: number }

export const DIAL_BOUNDS: Readonly<Record<string, NumberDial>> = Object.freeze({
  dcr_per_hour: { fallback: 10, floor: 1, ceiling: 100 },
  connector_use_stamp_minutes: { fallback: 60, floor: 1, ceiling: 1440 },
  // 10000 since the manager's ruling of 09/10/2026 (wayfinder jit_controls.ts).
  bridge_return_step_timeout_ms: { fallback: 10000, floor: 250, ceiling: 30000 },
});

export const DEFAULT_GATEWAY_DIALS: GatewayDials = Object.freeze({
  dcrPerHour: DIAL_BOUNDS.dcr_per_hour.fallback,
  clientIpHop: "first",
  createLimitMode: "log_only",
  connectorUseStampMinutes: DIAL_BOUNDS.connector_use_stamp_minutes.fallback,
  bridgeReturnStepTimeoutMs: DIAL_BOUNDS.bridge_return_step_timeout_ms.fallback,
  redirectPolicy: DEFAULT_REDIRECT_POLICY,
} as GatewayDials);

function numberDial(doc: Readonly<Record<string, unknown>> | null | undefined, field: string): number {
  const spec = DIAL_BOUNDS[field];
  const value = doc?.[field];
  if (typeof value !== "number" || !Number.isFinite(value)) return spec.fallback;
  return Math.min(spec.ceiling, Math.max(spec.floor, Math.floor(value)));
}

export function parseGatewayDials(docs: {
  controls?: Readonly<Record<string, unknown>> | null;
  redirect?: Readonly<Record<string, unknown>> | null;
  jit?: Readonly<Record<string, unknown>> | null;
}): GatewayDials {
  const hop = docs.controls?.client_ip_hop;
  const mode = docs.controls?.create_limit_mode;
  return {
    dcrPerHour: numberDial(docs.controls, "dcr_per_hour"),
    clientIpHop: hop === "right_most" ? "right_most" : "first",
    createLimitMode: mode === "enforce" ? "enforce" : "log_only",
    connectorUseStampMinutes: numberDial(docs.jit, "connector_use_stamp_minutes"),
    bridgeReturnStepTimeoutMs: numberDial(docs.jit, "bridge_return_step_timeout_ms"),
    redirectPolicy: parseRedirectPolicy(docs.redirect).policy,
  };
}

export type DocFetcher = (path: string) => Promise<Record<string, unknown> | null>;

const TTL_MS = 60_000;
let cache: GatewayDials | null = null;
let cacheAtMs = 0;
/** When a read last failed (B2a fix pass, CR-12): a failed read is not retried for the same minute. */
let failedAtMs = Number.NEGATIVE_INFINITY;

async function defaultFetcher(path: string): Promise<Record<string, unknown> | null> {
  const { db } = await import("../firestore-client.js");
  const snap = await db.doc(path).get();
  return snap.exists ? (snap.data() ?? null) : null;
}

let fetcher: DocFetcher = defaultFetcher;

/** The dials as last read, else the defaults; never reads (for a bound that must not wait). */
export function peekGatewayDials(): GatewayDials {
  return cache ?? DEFAULT_GATEWAY_DIALS;
}

/** The dials, read at most once a minute. Never throws. */
export async function loadGatewayDials(nowMs: number = Date.now()): Promise<GatewayDials> {
  if (cache != null && nowMs - cacheAtMs < TTL_MS) return cache;
  // CR-12: inside the minute after a failed read, serve the last good value (or the defaults)
  // without reading again, so a brownout costs one attempt a minute, not three reads per proxied call.
  if (nowMs - failedAtMs < TTL_MS) return cache ?? DEFAULT_GATEWAY_DIALS;
  try {
    const [controls, redirect, jit] = await Promise.all([
      fetcher(CONNECTOR_SIGNUP_CONTROLS_DOC),
      fetcher(OAUTH_REDIRECT_POLICY_DOC),
      fetcher(JIT_CONTROLS_DOC),
    ]);
    cache = parseGatewayDials({ controls, redirect, jit });
    cacheAtMs = nowMs;
  } catch (error) {
    failedAtMs = nowMs;
    console.warn(JSON.stringify({
      event: "gateway_dials_read_failed",
      kept: cache != null ? "last_good" : "default",
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  return cache ?? DEFAULT_GATEWAY_DIALS;
}

export function __setGatewayDialsFetcherForTest(fn: DocFetcher): void {
  fetcher = fn;
  cache = null;
  cacheAtMs = 0;
  failedAtMs = Number.NEGATIVE_INFINITY;
}

export function __resetGatewayDialsForTest(): void {
  fetcher = defaultFetcher;
  cache = null;
  cacheAtMs = 0;
  failedAtMs = Number.NEGATIVE_INFINITY;
}
