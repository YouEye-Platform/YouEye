/**
 * Unauthenticated health-check endpoint for Spine.
 *
 * BUG-017: Spine's post-update health check hit /api/health which requires
 * admin auth, causing 401 and false "update failed" reports. This endpoint
 * bypasses auth middleware (listed in PUBLIC_ROUTES) so Spine can verify
 * the Control Panel is running without needing a session.
 */

import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
