/**
 * Per-request context store for passing auth claims to MCP tool handlers.
 *
 * Uses AsyncLocalStorage to properly isolate auth claims per request,
 * ensuring concurrent requests on the same Cloud Run instance don't
 * share or overwrite each other's auth state.
 *
 * PEL-122: Fixed from module-level variable to AsyncLocalStorage.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { McpTokenClaims } from "./auth.js";

const authStore = new AsyncLocalStorage<McpTokenClaims | null>();

/**
 * Run a function with the given auth claims in an isolated async context.
 * All code inside the callback (including nested async calls) will see
 * the provided claims via getRequestAuth().
 */
export function runWithAuth<T>(claims: McpTokenClaims | null, fn: () => T): T {
  return authStore.run(claims, fn);
}

/**
 * Get the auth claims for the current request.
 * Called by tool handlers to check scope and get profile ID.
 * Returns null if called outside a runWithAuth() context.
 */
export function getRequestAuth(): McpTokenClaims | null {
  return authStore.getStore() ?? null;
}

// ── Backward-compatible shims (no-ops, kept to avoid import errors) ──

/** @deprecated Use runWithAuth() instead. Kept for backward compatibility. */
export function setRequestAuth(_claims: McpTokenClaims | null): void {
  // No-op. Auth is now set via runWithAuth().
}

/** @deprecated No longer needed with AsyncLocalStorage. Kept for backward compatibility. */
export function clearRequestAuth(): void {
  // No-op. AsyncLocalStorage automatically cleans up when the callback exits.
}
