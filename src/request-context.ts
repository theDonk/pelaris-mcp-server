/**
 * Per-request context store for passing auth claims to MCP tool handlers.
 *
 * Since the MCP SDK creates a fresh server per request in stateless mode,
 * we use a module-level variable to store the current request's auth claims.
 * This is safe because each request creates its own server instance and
 * the stateless mode processes one request at a time per server instance.
 */

import type { McpTokenClaims } from "./auth.js";

let _currentRequestAuth: McpTokenClaims | null = null;

/**
 * Set the auth claims for the current request.
 * Called before MCP tool processing begins.
 */
export function setRequestAuth(claims: McpTokenClaims | null): void {
  _currentRequestAuth = claims;
}

/**
 * Get the auth claims for the current request.
 * Called by tool handlers to check scope and get profile ID.
 */
export function getRequestAuth(): McpTokenClaims | null {
  return _currentRequestAuth;
}

/**
 * Clear the auth claims after request processing.
 */
export function clearRequestAuth(): void {
  _currentRequestAuth = null;
}
