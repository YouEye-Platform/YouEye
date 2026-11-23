/**
 * In-memory attempt limits (per Control Panel process; a restart clears them).
 * Re-exported by `session.ts`; kept free of Next and database imports so it can be tested on its own.
 */

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();
const SWEEP_SIZE = 10_000;

/**
 * Check rate limit for an IP/action combination
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number,
  windowSeconds: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  // Clean up expired entries now and then, and always once the store is large (keys made of random usernames).
  if (Math.random() < 0.01 || rateLimitStore.size >= SWEEP_SIZE) {
    for (const [k, v] of rateLimitStore) {
      if (v.resetAt < now) {
        rateLimitStore.delete(k);
      }
    }
  }

  if (!entry || entry.resetAt < now) {
    // Start new window
    const resetAt = now + windowSeconds * 1000;
    rateLimitStore.set(key, { count: 1, resetAt });
    return { allowed: true, remaining: maxAttempts - 1, resetAt };
  }

  if (entry.count >= maxAttempts) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count++;
  return { allowed: true, remaining: maxAttempts - entry.count, resetAt: entry.resetAt };
}

/**
 * Reset rate limit for a specific key (e.g., on successful login)
 */
export function resetRateLimit(key: string): void {
  rateLimitStore.delete(key);
}

/**
 * Reset all rate limits (admin action)
 */
export function resetAllRateLimits(): number {
  const count = rateLimitStore.size;
  rateLimitStore.clear();
  return count;
}

/** Whether `key` has used up `maxAttempts` in its current window, without counting an attempt. */
export function isRateLimited(key: string, maxAttempts: number): { limited: boolean; resetAt: number } {
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt < Date.now()) return { limited: false, resetAt: 0 };
  return { limited: entry.count >= maxAttempts, resetAt: entry.resetAt };
}

/** Give back one attempt counted for `key` (an attempt that turned out not to count, such as a success). */
export function refundRateLimit(key: string): void {
  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt < Date.now()) return;
  entry.count = Math.max(0, entry.count - 1);
}
