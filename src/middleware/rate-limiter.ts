/**
 * Per-user rate limiting middleware.
 *
 * Uses an in-memory Map with TTL — no external dependencies.
 * Limits: 60 reads per hour per user (identified by pseudonym or IP).
 */

import type { Response, NextFunction } from "express";
import type { McpAuthenticatedRequest } from "../auth.js";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_REQUESTS = 60;

// In-memory store keyed by user identifier
const limiterStore = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of limiterStore) {
    if (now - entry.windowStart > WINDOW_MS) {
      limiterStore.delete(key);
    }
  }
}, 5 * 60 * 1000).unref();

/**
 * Extract a user identifier for rate limiting.
 * Prefers the OAuth pseudonym (sub), falls back to IP.
 */
function getUserKey(req: McpAuthenticatedRequest): string {
  if (req.mcpAuth?.sub) return `user:${req.mcpAuth.sub}`;
  const forwarded = req.headers["x-forwarded-for"];
  const ip = typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.ip;
  return `ip:${ip || "unknown"}`;
}

/**
 * Rate limiting middleware.
 * Returns 429 with Retry-After header when limit exceeded.
 */
export function rateLimiter(
  req: McpAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  // Skip rate limiting for admin-authed requests
  if (req.isAdminAuth) {
    next();
    return;
  }

  const key = getUserKey(req);
  const now = Date.now();
  const entry = limiterStore.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    // New window
    limiterStore.set(key, { count: 1, windowStart: now });
    next();
    return;
  }

  if (entry.count >= MAX_REQUESTS) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfterSeconds));
    res.status(429).json({
      error: "rate_limit_exceeded",
      error_description: `Rate limit of ${MAX_REQUESTS} requests per hour exceeded. Retry after ${retryAfterSeconds} seconds.`,
    });
    return;
  }

  entry.count++;
  next();
}
