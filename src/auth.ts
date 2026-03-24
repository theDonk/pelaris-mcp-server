/**
 * Dual-strategy authentication middleware for Pelaris MCP server.
 *
 * DEBUG LOGGING ENABLED — remove after MCP connection issues are resolved.
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
  exp: number;
  iat: number;
}

export interface McpAuthenticatedRequest extends Request {
  mcpAuth?: McpTokenClaims;
  isAdminAuth?: boolean;
  requestId?: string;
}

// ─── JWT secret ───────────────────────────────────────────────────────────────

let _jwtSecret: string | null = null;

async function getJwtSecret(): Promise<string | null> {
  if (_jwtSecret) return _jwtSecret;

  if (process.env.MCP_JWT_SECRET) {
    _jwtSecret = process.env.MCP_JWT_SECRET;
    console.log(`[auth][DEBUG] JWT secret loaded from env var (length: ${_jwtSecret.length}, first8: ${_jwtSecret.substring(0, 8)})`);
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
      _jwtSecret = typeof payload === "string" ? payload : Buffer.from(payload).toString("utf8");
      console.log(`[auth][DEBUG] JWT secret loaded from Secret Manager (length: ${_jwtSecret.length}, first8: ${_jwtSecret.substring(0, 8)})`);
      return _jwtSecret;
    }
  } catch (err) {
    console.warn("[auth] Failed to load JWT secret from Secret Manager:", (err as Error).message);
  }

  console.error("[auth][DEBUG] NO JWT SECRET AVAILABLE");
  return null;
}

// ─── JWT verification ─────────────────────────────────────────────────────────

function verifyJwt(token: string, secret: string): McpTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    console.log(`[auth][DEBUG] JWT rejected: expected 3 parts, got ${parts.length}`);
    return null;
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // DEBUG: decode and log the header
  try {
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
    console.log(`[auth][DEBUG] JWT header: ${JSON.stringify(header)}`);
  } catch {
    console.log(`[auth][DEBUG] JWT header decode failed`);
  }

  // DEBUG: decode and log the payload (redact sensitive fields)
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    console.log(`[auth][DEBUG] JWT payload: sub=${payload.sub?.substring(0, 16)}..., platform=${payload.platform}, scope=${payload.scope}, exp=${payload.exp}, iat=${payload.iat}, profile_id=${payload.profile_id?.substring(0, 8)}...`);
  } catch {
    console.log(`[auth][DEBUG] JWT payload decode failed`);
  }

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`, "utf8")
    .digest("base64url");

  console.log(`[auth][DEBUG] Signature comparison: expected=${expectedSig.substring(0, 16)}... actual=${signatureB64.substring(0, 16)}... lengths: expected=${expectedSig.length} actual=${signatureB64.length}`);

  if (expectedSig.length !== signatureB64.length) {
    console.log(`[auth][DEBUG] JWT rejected: signature length mismatch`);
    return null;
  }

  const sigMatch = crypto.timingSafeEqual(
    Buffer.from(expectedSig, "utf8"),
    Buffer.from(signatureB64, "utf8"),
  );
  if (!sigMatch) {
    console.log(`[auth][DEBUG] JWT rejected: signature mismatch (secrets don't match between OAuth CF and MCP server)`);
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (!payload.sub || !payload.exp || !payload.iat) {
      console.log(`[auth][DEBUG] JWT rejected: missing required claims (sub=${!!payload.sub}, exp=${!!payload.exp}, iat=${!!payload.iat})`);
      return null;
    }
    console.log(`[auth][DEBUG] JWT VERIFIED SUCCESSFULLY for ${payload.sub?.substring(0, 16)}...`);
    return payload as McpTokenClaims;
  } catch {
    console.log(`[auth][DEBUG] JWT rejected: payload parse error`);
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
      console.log(`[auth][DEBUG] Token revocation check: hash=${tokenHash.substring(0, 16)}..., revoked=${data?.revoked}`);
      if (data?.revoked === true) return true;
    } else {
      console.log(`[auth][DEBUG] Token not in revocation store (hash=${tokenHash.substring(0, 16)}...) — treating as valid`);
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
  const resourceMetadataUrl = "https://pelaris-mcp-server-653063894036.australia-southeast1.run.app/.well-known/oauth-protected-resource";

  // DEBUG: log ALL request details
  console.log(`[auth][DEBUG] ══════════════════════════════════════════`);
  console.log(`[auth][DEBUG] ${req.method} ${req.path}`);
  console.log(`[auth][DEBUG] Headers: ${JSON.stringify({
    authorization: req.headers.authorization ? `${req.headers.authorization.substring(0, 30)}...` : "MISSING",
    "content-type": req.headers["content-type"],
    accept: req.headers.accept,
    origin: req.headers.origin,
    "user-agent": req.headers["user-agent"]?.substring(0, 60),
  })}`);

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.log(`[auth][DEBUG] REJECTED: No Bearer token. Auth header: "${authHeader || "NONE"}"`);
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
    res.status(401).json({ error: "missing_token", error_description: "Bearer token required" });
    return;
  }

  const token = authHeader.slice(7);
  console.log(`[auth][DEBUG] Token received (length: ${token.length}, first20: ${token.substring(0, 20)}..., last10: ...${token.substring(token.length - 10)})`);

  // Strategy 1: Try OAuth JWT
  const jwtSecret = await getJwtSecret();
  if (jwtSecret) {
    console.log(`[auth][DEBUG] Attempting JWT verification with secret (first8: ${jwtSecret.substring(0, 8)})`);
    const claims = verifyJwt(token, jwtSecret);
    if (claims) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (claims.exp <= nowSeconds) {
        console.log(`[auth][DEBUG] REJECTED: Token expired. exp=${claims.exp}, now=${nowSeconds}, diff=${nowSeconds - claims.exp}s ago`);
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        res.status(401).json({ error: "invalid_token", error_description: "Token has expired" });
        return;
      }

      if (await isTokenRevoked(token)) {
        console.log(`[auth][DEBUG] REJECTED: Token revoked`);
        res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
        res.status(401).json({ error: "invalid_token", error_description: "Token has been revoked" });
        return;
      }

      console.log(`[auth][DEBUG] ✅ AUTH SUCCESS (OAuth JWT) — platform=${claims.platform}, sub=${claims.sub?.substring(0, 16)}`);
      req.mcpAuth = claims;
      req.isAdminAuth = false;
      next();
      return;
    }
    console.log(`[auth][DEBUG] JWT verification failed — trying admin token fallback`);
  } else {
    console.log(`[auth][DEBUG] No JWT secret available — skipping JWT verification`);
  }

  // Strategy 2: Fall back to static bearer token
  const expectedToken = process.env.MCP_BEARER_TOKEN;
  if (expectedToken && token === expectedToken) {
    console.log(`[auth][DEBUG] ✅ AUTH SUCCESS (admin bearer token)`);
    req.isAdminAuth = true;
    next();
    return;
  }

  console.log(`[auth][DEBUG] ❌ ALL AUTH STRATEGIES FAILED`);
  console.log(`[auth][DEBUG] Token is not a valid JWT and does not match admin bearer token`);
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${resourceMetadataUrl}"`);
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
