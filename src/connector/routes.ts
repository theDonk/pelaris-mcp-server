/**
 * The gateway's connector routes (Pelaris 1.4 B2a lane C, C6; moved out of
 * `index.ts` in the B2a fix pass so each one can be tested with a stubbed
 * Firestore, limiter, bridge and function, CR-15):
 *
 *   - `POST /register`: Dynamic Client Registration, guarded by the vendored
 *     redirect policy, a capped registrant name and the shared `dcr_per_hour`
 *     limit (NEW registrations only; the idempotent lookup answers first);
 *   - `POST /token` and `POST /revoke`: proxies to the OAuth function, with
 *     outbound headers built from scratch (an inbound `x-pelaris-*` copy never
 *     passes) and the client address forwarded under the shared secret;
 *   - `runConnectorReturnStep`: B1R's return check before a direct tool on
 *     `POST /mcp`, never throwing, never for admin auth or a fail-open read.
 *
 * The behaviour is `index.ts`'s, line for line, except where a fix-pass item
 * says otherwise (SR-5: the DCR limit now refuses in every mode).
 */
import crypto from "crypto";
import express, { type Express, type Request, type Response } from "express";
import type { Firestore } from "firebase-admin/firestore";

import type { McpAuthenticatedRequest } from "../auth.js";
import { forwardedIpHeaders, gatewayClientIp, logHopShapeOnce } from "./client_ip.js";
import { dcrRefusedLine, normaliseClientName, raiseConnectorDcrRefusedAlertOnce } from "./dcr_guard.js";
import { loadGatewayDials, type GatewayDials } from "./dials.js";
import { classifyRedirectUris } from "./redirect_policy.js";
import { directToolCalls, runReturnHook, type BridgeCall } from "./return_hook.js";

export const DEFAULT_OAUTH_CF_BASE = "https://australia-southeast1-wayfinder-ai-fitness.cloudfunctions.net/mcpOAuthServer";

export type DcrLimitExceeded = { retryAfterSeconds: number; maxRequests: number } | null;

/** Everything the routes reach outside themselves, so a test can stub it. */
export interface RouteDeps {
  loadDials(): Promise<GatewayDials>;
  /** The Firestore client, loaded on first use (the module initialises Application Default Credentials). */
  firestore(): Promise<Pick<Firestore, "collection">>;
  checkDcrLimit(key: string, maxRequests: number): Promise<DcrLimitExceeded>;
  fetch: typeof fetch;
  oauthBase: string;
  headerSecret(): string | undefined;
  bridge: BridgeCall;
  /** One structured log line (a JSON object, written with a newline). */
  log(line: Record<string, unknown>): void;
}

export function defaultRouteDeps(): RouteDeps {
  return {
    loadDials: () => loadGatewayDials(),
    firestore: async () => (await import("../firestore-client.js")).db,
    checkDcrLimit: async (key, max) => (await import("../middleware/rate-limiter.js")).checkDcrLimit(key, max),
    fetch: (input, init) => fetch(input, init),
    oauthBase: process.env.OAUTH_CF_BASE || DEFAULT_OAUTH_CF_BASE,
    headerSecret: () => process.env.MCP_OAUTH_IP_HEADER_SECRET,
    bridge: async (tool, profileId, input) => (await import("../tools/shared/bridge_client.js")).callCoreBridge(tool, profileId, input),
    log: (line) => {
      process.stdout.write(JSON.stringify(line) + "\n");
    },
  };
}

// ── POST /register ──────────────────────────────────────────────────────────

/**
 * Dynamic Client Registration (DCR) for third-party apps. Pre-registered
 * clients (pelaris-claude, pelaris-chatgpt) bypass this. DCR is idempotent:
 * the same redirect_uris return the same client_id.
 */
export function registerHandler(deps: RouteDeps = defaultRouteDeps()): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      const { redirect_uris, client_name: rawClientName } = req.body || {};
      // B2a C6 (a): one redirect policy for both registrars (OH-1), the shared
      // dials, and a normalised, capped registrant name.
      const dials = await deps.loadDials();
      logHopShapeOnce(req, "gateway_register", dials.clientIpHop);
      const client_name = normaliseClientName(rawClientName);

      const verdict = classifyRedirectUris(redirect_uris, dials.redirectPolicy);
      if (!verdict.ok) {
        const refusedUri = verdict.index != null && Array.isArray(redirect_uris) ? redirect_uris[verdict.index] : undefined;
        const line = dcrRefusedLine({ reason: verdict.reason, scheme: verdict.scheme, refusedUri });
        deps.log(line as unknown as Record<string, unknown>);
        await raiseConnectorDcrRefusedAlertOnce(await deps.firestore(), line);
        if (verdict.reason === "missing") {
          res.status(400).json({ error: "invalid_request", error_description: "redirect_uris required" });
        } else {
          res.status(400).json({ error: "invalid_redirect_uri", error_description: "A redirect URI is not allowed" });
        }
        return;
      }

      // Idempotency: hash redirect_uris to create a deterministic client_id
      const uriHash = crypto.createHash("sha256")
        .update(redirect_uris.sort().join("|"))
        .digest("hex")
        .slice(0, 32);
      const clientId = `dyn-${uriHash}`;

      // Check if this client already exists in Firestore
      const dbRef = (await deps.firestore()).collection("mcp_clients").doc(clientId);
      const existing = await dbRef.get();

      if (existing.exists) {
        // Return existing client — idempotent
        const data = existing.data()!;
        res.status(200).json({
          client_id: clientId,
          client_name: data.client_name || client_name || "MCP Client",
          redirect_uris: data.redirect_uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
        return;
      }

      // B2a C6 (a): the shared dcr_per_hour limit counts only NEW registrations
      // (the idempotent lookup above missed). B2a fix pass (SR-5 = CR-7): it
      // refuses in EVERY mode, as the function's registrar does. `create_limit_mode`
      // is the profile-create limit's setting, not this one's; real assistants
      // re-register the same URIs, which the lookup above answers before the count.
      const dcrKey = gatewayClientIp(req, dials.clientIpHop) ?? "unknown";
      const exceeded = await deps.checkDcrLimit(dcrKey, dials.dcrPerHour);
      if (exceeded) {
        deps.log({
          severity: "WARNING",
          event: "dcr_limit_reached",
          registrar: "gateway",
          outcome: "refused",
          limit: exceeded.maxRequests,
        });
        res.setHeader("Retry-After", String(exceeded.retryAfterSeconds));
        res.status(429).json({ error: "rate_limit_exceeded", error_description: "Too many new registrations. Please try again later." });
        return;
      }

      // Create new dynamic client
      await dbRef.set({
        client_name: client_name || "MCP Client",
        redirect_uris,
        platform: "direct",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        created_at: new Date().toISOString(),
      });

      res.status(201).json({
        client_id: clientId,
        client_name: client_name || "MCP Client",
        redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      });
    } catch (err) {
      console.error("[register] DCR failed:", err);
      if (!res.headersSent) res.status(500).json({ error: "server_error", error_description: "Registration failed" });
    }
  };
}

// ── POST /token and POST /revoke ────────────────────────────────────────────

/**
 * Proxy one OAuth POST to the function. OAuth requires
 * application/x-www-form-urlencoded for token requests; JSON is forwarded as a
 * fallback. B2a C6 (b), OH-3: the function keys its limits on the client, not
 * on this proxy, only when the shared secret matches. Outbound headers are
 * built from scratch, so an inbound copy of either header never passes.
 */
export function oauthProxyHandler(
  path: "/oauth/token" | "/oauth/revoke",
  deps: RouteDeps = defaultRouteDeps(),
): (req: Request, res: Response) => Promise<void> {
  const surface = path === "/oauth/token" ? "gateway_token" : null;
  return async (req, res) => {
    try {
      const contentType = req.headers["content-type"] || "";
      const dials = await deps.loadDials();
      if (surface) logHopShapeOnce(req, surface, dials.clientIpHop);
      const ipHeaders = forwardedIpHeaders(req, { secret: deps.headerSecret(), hop: dials.clientIpHop });

      let upstream: globalThis.Response;
      if (contentType.includes("application/x-www-form-urlencoded")) {
        // Forward as form-encoded (per OAuth spec)
        const formBody = new URLSearchParams(req.body as Record<string, string>).toString();
        upstream = await deps.fetch(`${deps.oauthBase}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...ipHeaders },
          body: formBody,
        });
      } else {
        // Forward as JSON (fallback)
        upstream = await deps.fetch(`${deps.oauthBase}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...ipHeaders },
          body: JSON.stringify(req.body),
        });
      }

      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err) {
      console.error(`[oauth-proxy] ${path === "/oauth/token" ? "/token" : "/revoke"} failed:`, err);
      res.status(502).json({ error: "proxy_error", error_description: "Failed to reach authorization server" });
    }
  };
}

/** Mount `/register`, `/token` and `/revoke` on the gateway's app (the JSON body parser is the app's own). */
export function mountConnectorRoutes(app: Express, deps: RouteDeps = defaultRouteDeps()): void {
  app.post("/register", registerHandler(deps));
  app.post("/token", express.urlencoded({ extended: true }), oauthProxyHandler("/oauth/token", deps));
  app.post("/revoke", express.urlencoded({ extended: true }), oauthProxyHandler("/oauth/revoke", deps));
}

// ── POST /mcp: the return check ─────────────────────────────────────────────

/**
 * B2a C6 (h): before a DIRECT tool, B1R's return_check when the profile may
 * have a rested plan or a due stamp (bounded; never blocks the tool). Only
 * after the ownership check allowed the token (never on fail-open, never for
 * admin auth). Never throws: whatever happens here, the tool runs.
 */
export async function runConnectorReturnStep(
  req: McpAuthenticatedRequest,
  deps: Pick<RouteDeps, "loadDials" | "bridge" | "log"> = defaultRouteDeps(),
): Promise<void> {
  try {
    const connector = req.isAdminAuth ? undefined : req.connectorAccess;
    if (!connector) return;
    const tools = directToolCalls(req.body);
    if (tools.length === 0) return;
    const dials = await deps.loadDials();
    await runReturnHook({
      profileId: connector.profileId,
      profileData: connector.profileData,
      tools,
      bridge: deps.bridge,
      stampMinutes: dials.connectorUseStampMinutes,
      timeoutMs: dials.bridgeReturnStepTimeoutMs,
    });
  } catch {
    // A closed line, no message text: the tool still runs.
    deps.log({ severity: "WARNING", event: "gateway_return_check_error" });
  }
}
