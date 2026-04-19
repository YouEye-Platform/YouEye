const buckets = new Map();

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 120;

/**
 * Check rate limit for an app token.
 * @param {string} appToken - The app's identifier
 * @param {number} [maxRequests] - Max requests per window
 * @param {number} [windowMs] - Window duration in ms
 * @returns {{ allowed: boolean, remaining: number, resetMs: number }}
 */
export function checkRateLimit(appToken, maxRequests = DEFAULT_MAX_REQUESTS, windowMs = DEFAULT_WINDOW_MS) {
  const now = Date.now();
  let bucket = buckets.get(appToken);

  if (!bucket || now - bucket.windowStart >= windowMs) {
    bucket = { windowStart: now, count: 0 };
    buckets.set(appToken, bucket);
  }

  bucket.count++;
  const remaining = Math.max(0, maxRequests - bucket.count);
  const resetMs = bucket.windowStart + windowMs - now;

  return {
    allowed: bucket.count <= maxRequests,
    remaining,
    resetMs,
  };
}

// Cleanup stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > DEFAULT_WINDOW_MS * 2) {
      buckets.delete(key);
    }
  }
}, 300_000).unref();
