/**
 * Dual-strategy authentication middleware for Pelaris MCP server.
 *
 * Strategy 1 (primary): OAuth 2.0 JWT tokens issued by the PEL-67 OAuth server.
 *   - Verifies HMAC-SHA256 signature
 *   - Checks token expiry
 *   - Checks Firestore revocation status (mcp_tokens/{tokenHash})
 *   - Extracts user claims (profileId, scopes, platform, pseudonym)
 *
 * Strategy 2 (fallback): Static bearer token for admin tools.
 *   - Original MCP_BEARER_TOKEN env var check
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";
import { db } from "./firestore-client.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface McpTokenClaims {
  sub: string;          // Pseudonymous user ID
  scope: string;        // Space-delimited scopes
  platform: string;     // chatgpt | claude | gemini | direct
  profile_id: string;   // Internal Firestore profile/uid for lookups
  exp: number;          // Expiry (unix seconds)
  iat: number;          // Issued at (unix seconds)
}

export interface McpAuthenticatedRequest extends Request {
  mcpAuth?: McpTokenClaims;
  /** True when authenticated via static admin bearer token (not OAuth). */
  isAdminAuth?: boolean;
  /** Unique request ID for structured logging. */
  requestId?: string;
}

// ─── JWT secret ───────────────────────────────────────────────────────────────

let _jwtSecret: string | null = null;

/**
 * Load the JWT secret from GCP Secret Manager or environment variable.
 * Caches the result after first successful load.
 */
async function getJwtSecret(): Promise<string | null> {
  if (_jwtSecret) return _jwtSecret;

  // First try env var (set via Cloud Run secret mount or local dev)
  if (process.env.MCP_JWT_SECRET) {
    _jwtSecret = process.env.MCP_JWT_SECRET;
    return _jwtSecret;
  }

  // Try GCP Secret Manager
  try {
    const { SecretManagerServiceClient } = await import("@google-cloud/secret-manager");
    const client = new SecretManagerServiceClient();
    const projectId = process.env.GCP_PROJECT_ID || "wayfinder-ai-fitness";
    const [version] = await client.accessSecretVersion({
      name: `projects/${projectId}/secrets/pelaris-mcp-jwt-secret/versions/latest`,
    });
    const payload = version.payload?.data;
    if (payload) {
      _jwtSecret = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
      return _jwtSecret;
    }
  } catch (err) {
    // Secret Manager not available — fall through
    console.warn("[auth] Failed to load JWT secret from Secret Manager:", (err as Error).message);
  }

  return null;
}

// ─── JWT verification ─────────────────────────────────────────────────────────

function verifyJwt(token: string, secret: string): McpTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`, "utf8")
    .digest("base64url");

  // Constant-time comparison
  if (expectedSig.length !== signatureB64.length) return null;
  const sigMatch = crypto.timingSafeEqual(
    Buffer.from(expectedSig, "utf8"),
    Buffer.from(signatureB64, "utf8"),
  );
  if (!sigMatch) return null;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.sub || !payload.exp || !payload.iat) return null;
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
    // Fail open on Firestore errors to avoid blocking legitimate requests
    console.error("[auth] Firestore revocation check failed:", err);
  }
  return false;
}

// ─── Dual-strategy middleware ─────────────────────────────────────────────────

/**
 * Dual-auth middleware: tries OAuth JWT first, falls back to static bearer token.
 *
 * On success, sets `req.mcpAuth` (for OAuth) or `req.isAdminAuth` (for static token).
 */
export async function verifyBearerToken(
  req: McpAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "missing_token", error_description: "Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);

  // Strategy 1: Try OAuth JWT
  const jwtSecret = await getJwtSecret();
  if (jwtSecret) {
    const claims = verifyJwt(token, jwtSecret);
    if (claims) {
      // Check expiry
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (claims.exp <= nowSeconds) {
        res.status(401).json({ error: "invalid_token", error_description: "Token has expired" });
        return;
      }

      // Check revocation
      if (await isTokenRevoked(token)) {
        res.status(401).json({ error: "invalid_token", error_description: "Token has been revoked" });
        return;
      }

      req.mcpAuth = claims;
      req.isAdminAuth = false;
      next();
      return;
    }
  }

  // Strategy 2: Fall back to static bearer token (admin tools)
  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (expectedToken && token === expectedToken) {
    req.isAdminAuth = true;
    next();
    return;
  }

  // Both strategies failed
  res.status(401).json({ error: "invalid_token", error_description: "Token verification failed" });
}

// ─── Scope enforcement ────────────────────────────────────────────────────────

/**
 * Higher-order middleware that requires a specific OAuth scope.
 * Must be used AFTER verifyBearerToken. Admin-authed requests are rejected
 * since admin tokens don't carry scopes — use separate admin routes.
 */
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

/**
 * Check if a scope string contains the required scope.
 * Used by MCP tool handlers to validate scope before processing.
 */
export function hasScope(scopeString: string, requiredScope: string): boolean {
  return scopeString.split(/\s+/).includes(requiredScope);
}
