/**
 * Per-user rate limiting middleware.
 *
 * Uses an in-memory Map with TTL — no external dependencies.
 * Limits:
 *   - 60 reads per hour per user (identified by pseudonym or IP)
 *   - 20 writes per hour per user (separate bucket)
 */

import type { Response, NextFunction } from "express";
import type { McpAuthenticatedRequest } from "../auth.js";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_READ_REQUESTS = 60;
const MAX_WRITE_REQUESTS = 20;

// In-memory stores keyed by user identifier
const readLimiterStore = new Map<string, RateLimitEntry>();
const writeLimiterStore = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const store of [readLimiterStore, writeLimiterStore]) {
    for (const [key, entry] of store) {
      if (now - entry.windowStart > WINDOW_MS) {
        store.delete(key);
      }
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
 * Check and increment a rate limit bucket.
 * Returns null if within limit, or an error object if exceeded.
 */
function checkLimit(
  store: Map<string, RateLimitEntry>,
  key: string,
  maxRequests: number,
  now: number,
): { retryAfterSeconds: number; maxRequests: number } | null {
  const entry = store.get(key);

  if (!entry || now - entry.windowStart > WINDOW_MS) {
    // New window
    store.set(key, { count: 1, windowStart: now });
    return null;
  }

  if (entry.count >= maxRequests) {
    const retryAfterSeconds = Math.ceil((entry.windowStart + WINDOW_MS - now) / 1000);
    return { retryAfterSeconds, maxRequests };
  }

  entry.count++;
  return null;
}

/**
 * Rate limiting middleware for read operations (default).
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
  const exceeded = checkLimit(readLimiterStore, key, MAX_READ_REQUESTS, now);

  if (exceeded) {
    res.set("Retry-After", String(exceeded.retryAfterSeconds));
    res.status(429).json({
      error: "rate_limit_exceeded",
      error_description: `Rate limit of ${exceeded.maxRequests} requests per hour exceeded. Retry after ${exceeded.retryAfterSeconds} seconds.`,
    });
    return;
  }

  next();
}

/**
 * Check and increment the write rate limit for a user.
 * Called by write tool handlers (not middleware — tools self-enforce).
 * Returns null if within limit, or an error message string if exceeded.
 */
export function checkWriteRateLimit(userKey: string): string | null {
  const now = Date.now();
  const exceeded = checkLimit(writeLimiterStore, `write:${userKey}`, MAX_WRITE_REQUESTS, now);
  if (exceeded) {
    return `Write rate limit of ${MAX_WRITE_REQUESTS} writes per hour exceeded. Retry after ${exceeded.retryAfterSeconds} seconds.`;
  }
  return null;
}
