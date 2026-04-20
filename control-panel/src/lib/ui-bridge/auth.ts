/**
 * UI Bridge Authentication — CP Side
 *
 * One-Way Bridge: CP's /api/ui-bridge/* routes are for EMBEDS only.
 * UI server never calls CP. Bridge token auth is intentionally disabled
 * on CP to enforce this isolation.
 *
 * Embeds are CP pages loaded in UI iframes. When embed client-side code
 * makes fetch calls to these routes, they're same-origin (CP→CP) and
 * validated via Referer header.
 */

import { NextResponse } from 'next/server';

/**
 * Validate requests to CP's /api/ui-bridge/* routes.
 * Returns null if valid, or a NextResponse with 401 status if invalid.
 *
 * ONLY accepts same-origin embed requests (Referer from /embed/*).
 * Bridge token auth is intentionally NOT accepted — UI server should
 * never call CP. This enforces one-way bridge architecture.
 *
 * Usage in route handlers:
 * ```
 * const authError = await validateBridgeToken(request);
 * if (authError) return authError;
 * ```
 */
export async function validateBridgeToken(
  request: Request
): Promise<NextResponse | null> {
  // Only accept same-origin embed requests (Referer starts with /embed/)
  const referer = request.headers.get('referer');
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.pathname.startsWith('/embed/')) {
        return null;
      }
    } catch {
      // Invalid referer URL
    }
  }

  // Reject everything else — including bridge token attempts
  // This enforces one-way bridge (CP→UI only, UI never calls CP)
  return NextResponse.json(
    { error: 'Unauthorized: embed requests only', valid: false },
    { status: 401 }
  );
}
