/**
 * Per-user rate limiting middleware.
 *
 * Uses an in-memory Map with TTL — no external dependencies.
 * Limits:
 *   - 60 reads per hour per user (identified by pseudonym or IP)
 *   - 50 writes per hour per user (separate bucket)
 */

import type { Response, NextFunction } from "express";
import type { McpAuthenticatedRequest } from "../auth.js";
import { db } from "../firestore-client.js";

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_READ_REQUESTS = 60;
const MAX_WRITE_REQUESTS = 50;
// Program generation runs live server-side AI inference: a denial-of-wallet surface,
// so it is limited far tighter than ordinary writes (Unified Uplift G3 C-3).
const MAX_GENERATION_REQUESTS = 10;

// Read limiting (the /mcp middleware) is Firestore-backed so the limit is
// global across Cloud Run instances (an in-memory Map is per-instance and is
// bypassed by fan-out / cold starts — security audit). Write and generation
// buckets stay in-memory for now (they are secondary, authenticated, and
// entitlement-gated; the max-instances cap bounds generation cost too).
const writeLimiterStore = new Map<string, RateLimitEntry>();
const generationLimiterStore = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired in-memory entries (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const store of [writeLimiterStore, generationLimiterStore]) {
    for (const [key, entry] of store) {
      if (now - entry.windowStart > WINDOW_MS) {
        store.delete(key);
      }
    }
  }
}, 5 * 60 * 1000).unref();

/** Firestore doc id: keep it collision-free and id-safe (no "/", bounded). */
function limitDocId(key: string): string {
  return key.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 1400);
}

/**
 * Global (cross-instance) fixed-window counter backed by one Firestore doc per
 * key. Atomic via a transaction so concurrent requests can't over-count.
 * Fails OPEN on a store error: a throttle outage must not deny service (it
 * grants no access — verifyBearerToken already ran).
 */
async function checkFirestoreLimit(
  key: string,
  maxRequests: number,
  now: number,
): Promise<{ retryAfterSeconds: number; maxRequests: number } | null> {
  const ref = db.collection("mcp_rate_limits").doc(limitDocId(key));
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists ? (snap.data() as RateLimitEntry) : null;
      if (!data || now - data.windowStart > WINDOW_MS) {
        tx.set(ref, { count: 1, windowStart: now });
        return null;
      }
      if (data.count >= maxRequests) {
        return {
          retryAfterSeconds: Math.ceil((data.windowStart + WINDOW_MS - now) / 1000),
          maxRequests,
        };
      }
      tx.update(ref, { count: data.count + 1 });
      return null;
    });
  } catch (err) {
    console.error("[rate-limiter] Firestore limit check failed, allowing:", err);
    return null;
  }
}

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
export async function rateLimiter(
  req: McpAuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Skip rate limiting for admin-authed requests
  if (req.isAdminAuth) {
    next();
    return;
  }

  const key = getUserKey(req);
  const now = Date.now();
  const exceeded = await checkFirestoreLimit(key, MAX_READ_REQUESTS, now);

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

/**
 * Check and increment the PROGRAM-GENERATION rate limit (separate, much tighter
 * bucket). Program generation triggers live server-side AI inference, so it is a
 * denial-of-wallet surface and is limited well below ordinary writes
 * (Unified Uplift G3 C-3). Returns null if within limit, else an error message.
 */
export function checkGenerationRateLimit(userKey: string): string | null {
  const now = Date.now();
  const exceeded = checkLimit(generationLimiterStore, `gen:${userKey}`, MAX_GENERATION_REQUESTS, now);
  if (exceeded) {
    return `Program-generation rate limit of ${MAX_GENERATION_REQUESTS} per hour exceeded. Retry after ${exceeded.retryAfterSeconds} seconds.`;
  }
  return null;
}
