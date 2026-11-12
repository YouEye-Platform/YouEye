/**
 * Authorization for the CP's own /api/ui-bridge/* routes.
 *
 * These routes serve the CP's embed pages (/embed/*, shown by the dashboard in
 * iframes). The embed's browser code calls them same-origin, so the caller is
 * whoever holds the CP session cookie: every request needs a valid CP session
 * of an admin (every embed is admin-only), and every state change also needs
 * the CSRF token (`X-CSRF-Token` matching the `ye-csrf` cookie, as on every
 * other CP route; `authenticatedFetch` sends it).
 *
 * The UI server never calls these routes (CP → UI only), and nothing here
 * trusts a Referer or a bridge token.
 */

import { NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { embedBridgeDecision, SAFE_METHODS } from './embed-decision';

/**
 * Returns null when the request may proceed, or the refusal response.
 *
 * ```
 * const authError = await requireEmbedAdmin(request);
 * if (authError) return authError;
 * ```
 */
export async function requireEmbedAdmin(request: Request): Promise<NextResponse | null> {
  const session = await getSession();
  const csrfToken = request.headers.get('x-csrf-token');
  const csrfValid = SAFE_METHODS.has(request.method.toUpperCase())
    ? true
    : Boolean(csrfToken) && await verifyCSRFToken(csrfToken!);
  const refusal = embedBridgeDecision({ method: request.method, session, csrfValid });
  return refusal ? NextResponse.json({ error: refusal.error }, { status: refusal.status }) : null;
}
