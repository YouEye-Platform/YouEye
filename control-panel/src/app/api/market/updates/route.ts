/**
 * App Market Updates API — Check for available updates.
 *
 * GET /api/market/updates
 *   Returns list of installed apps with available updates.
 *
 * POST /api/market/updates
 *   Force a fresh version check (clears cache, re-fetches catalog).
 */

import { NextRequest } from 'next/server';
import {
  getLastVersionCheckResults,
  getLastVersionCheckAt,
  isVersionCheckInProgress,
  refreshVersionCheck,
} from '@/lib/market/version-checker';
import { getAppsWithUpdatesAvailable } from '@/lib/market/installed-apps';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Try DB first (authoritative), fall back to in-memory cache
    let apps;
    try {
      apps = await getAppsWithUpdatesAvailable();
    } catch {
      apps = getLastVersionCheckResults();
    }

    return Response.json({
      apps,
      lastCheckedAt: getLastVersionCheckAt(),
      checking: isVersionCheckInProgress(),
    });
  } catch (err) {
    return Response.json(
      { error: `Failed to check updates: ${err}` },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    if (isVersionCheckInProgress()) {
      return Response.json({
        message: 'Version check already in progress',
        checking: true,
      });
    }

    const appsWithUpdates = await refreshVersionCheck();

    return Response.json({
      apps: appsWithUpdates,
      lastCheckedAt: getLastVersionCheckAt(),
      checking: false,
    });
  } catch (err) {
    return Response.json(
      { error: `Version check failed: ${err}` },
      { status: 500 }
    );
  }
}
