/**
 * bridge_client.ts: thin client for the wayfinder `coreToolsBridge` Cloud
 * Function (ST-6 / Unified Uplift G2).
 *
 * This MCP server cannot import wayfinder's `tools/core`: incompatible module
 * systems (this repo is ESM/NodeNext, functions is CJS) and `tools/core`
 * transitively pulls the generation pipeline + firebase-functions, which would bloat AND leak
 * internal logic into this PUBLIC bundle. Instead the server reaches core's ONE
 * implementation over this thin authenticated internal HTTP door, so it stops
 * reimplementing session logic (the reimplementation is exactly how F1 happened:
 * the session tools resolved the diary only and 404'd on queue-resident sessions
 * that the read tools advertised). Ownership, scope, and scrubbing stay in the
 * CALLING MCP wrapper, never here.
 *
 * Auth mirrors generate_weekly_plan: a Google-signed service-account ID token,
 * audience-bound to the CF URL. In the local emulator (FIRESTORE_EMULATOR_HOST
 * set) no token is minted and CF_BASE_URL points at the functions emulator; the
 * bridge's own FUNCTIONS_EMULATOR-gated bypass accepts the unauthenticated call.
 *
 * PUBLIC-REPO SAFETY: no secret/token/key is stored here. CF_BASE_URL is the
 * same public prod Cloud Functions URL generate_weekly_plan already uses.
 */

import { GoogleAuth } from "google-auth-library";

const CF_BASE_URL =
  process.env.CF_BASE_URL || "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net";

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) _auth = new GoogleAuth();
  return _auth;
}

function isEmulator(): boolean {
  return !!process.env.FIRESTORE_EMULATOR_HOST;
}

/** The { ok, tool, result?, error?, errorDetail? } envelope coreToolsBridge returns. */
export interface BridgeResult {
  ok: boolean;
  tool: string;
  result?: unknown;
  error?: string;
  /** Structured detail on failures (e.g. preflight candidate ids) so the
   *  calling agent can self-correct. Only present on newer bridge envelopes. */
  errorDetail?: unknown;
}

/**
 * Call a curated tools/core endpoint via the coreToolsBridge CF. Returns the
 * parsed envelope. Throws on transport failure so the caller can decide how to
 * degrade (the session tools fall back to their original not-found behaviour).
 */
export async function callCoreBridge(
  tool: string,
  profileId: string,
  input: Record<string, unknown>,
): Promise<BridgeResult> {
  const targetUrl = `${CF_BASE_URL}/coreToolsBridge`;
  const payload = { tool, profileId, input };

  if (isEmulator()) {
    // Local rig: the functions emulator has no IAM, and minting an ID token for
    // a non-https emulator URL would fail. The bridge bypasses auth when
    // FUNCTIONS_EMULATOR is set, so a plain fetch is correct here.
    const resp = await fetch(targetUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    return (await resp.json()) as BridgeResult;
  }

  const client = await getAuth().getIdTokenClient(targetUrl);
  const response = await client.request({
    url: targetUrl,
    method: "POST",
    data: payload,
    timeout: 120_000,
  });
  return response.data as BridgeResult;
}
