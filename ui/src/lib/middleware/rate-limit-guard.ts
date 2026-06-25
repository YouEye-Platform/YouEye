/**
 * Rate Limit Guard for Inter-App API Routes
 *
 * Wraps route handlers with rate limiting and optional HMAC verification.
 * Applied to inter-app endpoints: notifications, timeline, info-card, gateway.
 *
 * Usage:
 *   export const POST = withRateLimit('notifications', RATE_LIMITS.notifications, handler);
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  checkRateLimit,
  type RateLimitConfig,
} from '@/lib/rate-limit';
import {
  computeHmac,
  verifyHmac,
  getAppSecret,
  isSignatureRequired,
} from '@/lib/auth/hmac';

type RouteHandler = (
  request: NextRequest,
  context?: unknown
) => Promise<NextResponse> | NextResponse;

/**
 * Wrap a route handler with rate limiting and HMAC verification.
 *
 * @param endpointName - Name used for rate limit bucketing (e.g., 'notifications')
 * @param config - Rate limit configuration
 * @param handler - The actual route handler
 */
export function withRateLimit(
  endpointName: string,
  config: RateLimitConfig,
  handler: RouteHandler
): RouteHandler {
  return async (request: NextRequest, context?: unknown) => {
    // Extract app slug from header (service-to-service calls)
    const appSlug =
      request.headers.get('x-app-slug') ??
      request.headers.get('x-youeye-app') ??
      'unknown';

    // Skip rate limiting for browser requests (have session cookie)
    const sessionCookie = request.cookies.get('ye-ui-session');
    if (sessionCookie?.value && appSlug === 'unknown') {
      return handler(request, context);
    }

    // ── Rate Limit Check ──────────────────────────────────
    const result = checkRateLimit(appSlug, endpointName, config);

    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.resetMs / 1000);
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          message: `Rate limit exceeded for app "${appSlug}" on endpoint "${endpointName}". Limit: ${result.limit}/min.`,
          retry_after: retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Limit': String(result.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(retryAfterSeconds),
          },
        }
      );
    }

    // ── HMAC Signature Verification ───────────────────────
    const signature = request.headers.get('x-app-signature');
    const requireSigs = await isSignatureRequired();

    if (signature && appSlug !== 'unknown') {
      // Verify provided signature
      const secret = await getAppSecret(appSlug);
      if (secret) {
        const body = await request.clone().text();
        const expected = computeHmac(body, secret);
        if (!verifyHmac(signature, expected)) {
          return NextResponse.json(
            { error: 'Unauthorized', message: 'Invalid HMAC signature' },
            { status: 401 }
          );
        }
      }
    } else if (requireSigs && appSlug !== 'unknown') {
      // Signature required but not provided
      return NextResponse.json(
        {
          error: 'Unauthorized',
          message: 'HMAC signature required. Include X-App-Signature header.',
        },
        { status: 401 }
      );
    }
    // else: grace period — no signature required, let through

    // ── Execute handler with rate limit headers ───────────
    const response = await handler(request, context);

    // Add rate limit headers to response
    response.headers.set('X-RateLimit-Limit', String(result.limit));
    response.headers.set(
      'X-RateLimit-Remaining',
      String(result.remaining)
    );

    return response;
  };
}
