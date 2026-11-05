/**
 * Install Status API — poll for install progress.
 *
 * GET /api/market/install-status?app=appId
 *   Returns the tracked install state (events, done, error) for a specific app.
 *
 * GET /api/market/install-status
 *   Returns all active/recent installs.
 */

import { NextRequest } from 'next/server';
import { getTrackedInstall, getAllActiveInstalls } from '@/lib/market/install-tracker';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get('app');

  if (appId) {
    const install = getTrackedInstall(appId);
    if (!install) {
      return new Response(
        JSON.stringify({ error: 'No tracked install found for this app' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return Response.json(install);
  }

  // Return all active installs
  const installs = getAllActiveInstalls();
  return Response.json({ installs });
}
