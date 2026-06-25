/**
 * Token-Bucket Rate Limiter
 *
 * In-memory rate limiter for inter-app API endpoints.
 * Per-app-slug limits prevent misbehaving apps from spamming the platform.
 *
 * Note: Resets on process restart — acceptable for throttling (not a security boundary).
 */

// ─── Types ──────────────────────────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  /** Maximum requests per window */
  limit: number;
  /** Window duration in milliseconds */
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  limit: number;
}

// ─── Preset Limits ──────────────────────────────────────

export const RATE_LIMITS = {
  /** Inter-app gateway: 60 requests/minute per app slug */
  gateway: { limit: 60, windowMs: 60_000 },
  /** Notification ingest: 10 notifications/minute per app slug */
  notifications: { limit: 10, windowMs: 60_000 },
  /** Timeline write: 30 events/minute per app slug */
  timeline: { limit: 30, windowMs: 60_000 },
  /** Info card fetch: 120 requests/minute per app slug (read-heavy) */
  infoCard: { limit: 120, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitConfig>;

// ─── In-Memory Store ────────────────────────────────────

/** Map: `${appSlug}:${endpoint}` -> TokenBucket */
const buckets = new Map<string, TokenBucket>();

/** Clean up expired buckets every 5 minutes */
const CLEANUP_INTERVAL_MS = 5 * 60_000;
let lastCleanup = Date.now();

function cleanupExpiredBuckets(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, bucket] of buckets) {
    // Remove buckets that haven't been used in 10 minutes
    if (now - bucket.lastRefill > 10 * 60_000) {
      buckets.delete(key);
    }
  }
}

// ─── Rate Limit Check ───────────────────────────────────

/**
 * Check if a request from an app to an endpoint is within rate limits.
 * Uses a sliding window token bucket algorithm.
 */
export function checkRateLimit(
  appSlug: string,
  endpoint: string,
  config: RateLimitConfig
): RateLimitResult {
  cleanupExpiredBuckets();

  const key = `${appSlug}:${endpoint}`;
  const now = Date.now();

  let bucket = buckets.get(key);

  if (!bucket) {
    // First request — create bucket with full tokens minus 1 for this request
    bucket = { tokens: config.limit - 1, lastRefill: now };
    buckets.set(key, bucket);
    return {
      allowed: true,
      remaining: config.limit - 1,
      resetMs: config.windowMs,
      limit: config.limit,
    };
  }

  // Calculate elapsed time since last refill
  const elapsed = now - bucket.lastRefill;

  // Refill tokens based on elapsed time (proportional to window)
  const refillRate = config.limit / config.windowMs;
  const tokensToAdd = elapsed * refillRate;
  bucket.tokens = Math.min(config.limit, bucket.tokens + tokensToAdd);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    // Consume a token
    bucket.tokens -= 1;
    return {
      allowed: true,
      remaining: Math.floor(bucket.tokens),
      resetMs: Math.ceil((1 - (bucket.tokens % 1)) / refillRate),
      limit: config.limit,
    };
  }

  // No tokens left — rate limited
  const resetMs = Math.ceil((1 - bucket.tokens) / refillRate);
  return {
    allowed: false,
    remaining: 0,
    resetMs,
    limit: config.limit,
  };
}

// ─── Rate Limit Status ──────────────────────────────────

export interface RateLimitStatus {
  endpoint: string;
  remaining: number;
  limit: number;
  lastActivity: number;
}

/**
 * Get rate limit status for all endpoints of a given app slug.
 * Used by the admin monitoring dashboard.
 */
export function getRateLimitStatus(appSlug: string): RateLimitStatus[] {
  const statuses: RateLimitStatus[] = [];
  const prefix = `${appSlug}:`;

  for (const [key, bucket] of buckets) {
    if (key.startsWith(prefix)) {
      const endpoint = key.slice(prefix.length);
      statuses.push({
        endpoint,
        remaining: Math.floor(bucket.tokens),
        limit: 0, // Will be populated by caller with the correct config
        lastActivity: bucket.lastRefill,
      });
    }
  }

  return statuses;
}
