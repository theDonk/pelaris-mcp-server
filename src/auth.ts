/**
 * Dual-strategy authentication middleware for Pelaris MCP server.
 *
 * Strategy 1 (primary): OAuth 2.0 JWT tokens issued by the PEL-67 OAuth server.
 * Strategy 2 (fallback): Static bearer token for admin tools.
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./firestore-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpTokenClaims {
  sub: string;
  scope: string;
  platform: string;
  profile_id: string;
  client_id?: string; // PEL-102: added for connected_apps tracking (optional for backward compat)
  aud?: string | string[]; // RFC 8707 audience binding (optional during rollout)
  exp: number;
  iat: number;
}

export interface McpAuthenticatedRequest extends Request {
  mcpAuth?: McpTokenClaims;
  isAdminAuth?: boolean;
  requestId?: string;
}

// ─── RFC 8707 audience binding ──────────────────────────────────────────────────
// The canonical MCP resource identifier (exact: scheme+host+path, no trailing
// slash) — must equal the `resource` advertised by protected-resource metadata.
// Access tokens carry aud = this value; a token whose aud is PRESENT but does
// not match is rejected. `aud` may be a string or (RFC 7519) an array.
const CANONICAL_AUDIENCE = "https://api.pelaris.io/mcp";
// After this instant a MISSING aud is also rejected (require aud). The resource
// server only ever sees 1h access tokens, so every token carries aud within an
// hour of the signer rollout; this is a generous margin past that. Coded so
// enforcement is automatic, not a manual flip that could be forgotten.
const AUD_ENFORCE_AT = Date.parse("2026-09-01T00:00:00Z");

function audienceAccepted(aud: unknown): boolean {
  if (typeof aud === "string") return aud === CANONICAL_AUDIENCE;
  if (Array.isArray(aud)) return aud.includes(CANONICAL_AUDIENCE);
  return false; // present but not a string/array (null, object, …) → reject
}

// ─── JWT secret ───────────────────────────────────────────────────────────────

let _jwtSecret: string | null = null;

async function getJwtSecret(): Promise<string | null> {
  if (_jwtSecret) return _jwtSecret;

  if (process.env.MCP_JWT_SECRET) {
    _jwtSecret = process.env.MCP_JWT_SECRET.trim();
    return _jwtSecret;
  }

  try {
    const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT_ID || "wayfinder-ai-fitness";
    const [version] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/pelaris-mcp-jwt-secret/versions/latest`,
    });
    const payload = version.payload?.data;
    if (payload) {
      _jwtSecret = (typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8")).trim();
      return _jwtSecret;
    }
  } catch (err) {
    console.warn("[auth] Failed to load JWT secret from Secret Manager:", (err as Error).message);
  }

  return null;
}

// ─── JWT verification ─────────────────────────────────────────────────────────

/**
 * Constant-time string equality for comparing secrets (security audit).
 * Both sides are SHA-256'd to a fixed length so timingSafeEqual never throws
 * on a length mismatch and no length information leaks.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a, "utf8").digest();
  const bh = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ah, bh);
}

function verifyJwt(token: string, secret: string): McpTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`, "utf8")
    .digest("base64url");

  if (expectedSig.length !== signatureB64.length) {
    return null;
  }

  const sigMatch = crypto.timingSafeEqual(
    Buffer.from(expectedSig, "utf8"),
    Buffer.from(signatureB64, "utf8"),
  );
  if (!sigMatch) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.sub || !payload.exp || !payload.iat) {
      return null;
    }
    // Reject a refresh token presented as an access bearer token. Refresh
    // tokens carry type:"refresh" and a 30-day TTL; access tokens carry no
    // type. Without this check a stolen refresh token authenticates at /mcp
    // for 30 days, defeating the 1h access-token TTL (security audit H1).
    if (payload.type === "refresh") {
      return null;
    }
    return payload as McpTokenClaims;
  } catch {
    return null;
  }
}

// ─── Revocation check ─────────────────────────────────────────────────────────

async function isTokenRevoked(token: string): Promise<boolean> {
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  try {
    const tokenDoc = await db.collection("mcp_tokens").doc(tokenHash).get();
    if (tokenDoc.exists) {
      const data = tokenDoc.data();
      if (data?.revoked === true) return true;
    }
  } catch (err) {
    console.error("[auth] Firestore revocation check failed:", err);
  }
  return false;
}

// ─── Dual-strategy middleware ─────────────────────────────────────────────────

export async function verifyBearerToken(
  req: McpAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const resourceMetadataUrl = "https://api.pelaris.io/.well-known/oauth-protected-resource/mcp";

  const mcpRealm = "https://api.pelaris.io/mcp";

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.setHeader("WWW-Authenticate", `Bearer realm="${mcpRealm}", resource_metadata="${resourceMetadataUrl}"`);
    res.status(401).json({ error: "missing_token", error_description: "Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);

  // Strategy 1: Try OAuth JWT
  const jwtSecret = await getJwtSecret();
  if (jwtSecret) {
    const claims = verifyJwt(token, jwtSecret);
    if (claims) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (claims.exp <= nowSeconds) {
        res.setHeader("WWW-Authenticate", `Bearer realm="${mcpRealm}", error="invalid_token", error_description="The access token has expired", resource_metadata="${resourceMetadataUrl}"`);
        res.status(401).json({ error: "invalid_token", error_description: "Token has expired" });
        return;
      }

      if (await isTokenRevoked(token)) {
        res.setHeader("WWW-Authenticate", `Bearer realm="${mcpRealm}", error="invalid_token", error_description="The access token has been revoked", resource_metadata="${resourceMetadataUrl}"`);
        res.status(401).json({ error: "invalid_token", error_description: "Token has been revoked" });
        return;
      }

      // RFC 8707 audience binding. Fail closed on a PRESENT-but-wrong aud
      // always; allow a MISSING aud only until AUD_ENFORCE_AT (the ~1h
      // access-token rotation window after the signer rollout). Strictly inside
      // the JWT branch — the static admin token (Strategy 2) is never subject to aud.
      const audMissing = claims.aud === undefined;
      if ((!audMissing || Date.now() >= AUD_ENFORCE_AT) && !audienceAccepted(claims.aud)) {
        res.setHeader("WWW-Authenticate", `Bearer realm="${mcpRealm}", error="invalid_token", error_description="Token audience is not valid for this resource", resource_metadata="${resourceMetadataUrl}"`);
        res.status(401).json({ error: "invalid_token", error_description: "Token audience mismatch" });
        return;
      }

      req.mcpAuth = claims;
      req.isAdminAuth = false;

      // PEL-102: Fire-and-forget last_used_at update for connected_apps tracking.
      // Non-blocking to avoid adding latency to MCP tool calls.
      updateLastUsedAt(token, claims).catch(() => {});

      next();
      return;
    }
  }

  // Strategy 2: Fall back to static bearer token.
  // Constant-time compare so the response time cannot leak how many leading
  // characters of the admin token a guess matched (timing attack). Hash both
  // sides to a fixed 32 bytes first: timingSafeEqual throws on unequal lengths,
  // and comparing raw lengths would itself leak the token length.
  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (expectedToken && constantTimeEquals(token, expectedToken)) {
    req.isAdminAuth = true;
    next();
    return;
  }

  res.setHeader("WWW-Authenticate", `Bearer realm="${mcpRealm}", error="invalid_token", error_description="Token verification failed", resource_metadata="${resourceMetadataUrl}"`);
  res.status(401).json({ error: "invalid_token", error_description: "Token verification failed" });
}

// ─── Scope enforcement ────────────────────────────────────────────────────────

export function requireScope(scope: string) {
  return (req: McpAuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.mcpAuth) {
      res.status(401).json({
        error: "missing_token",
        error_description: "OAuth authentication required for this endpoint",
      });
      return;
    }

    const grantedScopes = req.mcpAuth.scope.split(/\s+/);
    if (!grantedScopes.includes(scope)) {
      res.status(403).json({
        error: "insufficient_scope",
        error_description: `Required scope: ${scope}`,
      });
      return;
    }

    next();
  };
}

export function hasScope(scopeString: string, requiredScope: string): boolean {
  return scopeString.split(/\s+/).includes(requiredScope);
}

// ─── last_used_at tracking (PEL-102) ─────────────────────────────────────────

// Debounce interval: only update last_used_at once per 5 minutes per client.
const LAST_USED_DEBOUNCE_MS = 5 * 60 * 1000;
const _lastUsedTimestamps = new Map<string, number>();

/**
 * Fire-and-forget update of last_used_at on connected_apps.
 * Debounced to avoid a Firestore write on every single MCP request.
 */
async function updateLastUsedAt(token: string, claims: McpTokenClaims): Promise<void> {
  const clientId = claims.client_id;
  const profileId = claims.profile_id;
  if (!clientId || !profileId) return;

  const debounceKey = `${profileId}:${clientId}`;
  const now = Date.now();
  const lastUpdated = _lastUsedTimestamps.get(debounceKey) ?? 0;
  if (now - lastUpdated < LAST_USED_DEBOUNCE_MS) return;

  _lastUsedTimestamps.set(debounceKey, now);

  try {
    const { FieldValue } = await import("firebase-admin/firestore");
    const connectedAppRef = db.collection("profiles").doc(profileId)
      .collection("connected_apps").doc(clientId);
    await connectedAppRef.update({ last_used_at: FieldValue.serverTimestamp() });
  } catch {
    // Silently ignore - non-critical tracking update
  }
}
