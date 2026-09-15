/**
 * POST /api/apps/check-updates — compatibility route for the youeye CLI.
 *
 * `youeye app check-updates` (every deployed spine) POSTs here and renders
 * rows from `apps[]` (appId/installedVersion/catalogVersion/updateAvailable).
 * The route was removed when check-for-updates was unified into
 * /api/market/updates, silently 404ing the CLI. Kept as a thin alias.
 */

import {
  isVersionCheckInProgress,
  refreshVersionCheck,
  getLastVersionCheckAt,
} from '@/lib/market/version-checker';
import { getAllInstalledApps } from '@/lib/market/installed-apps';

export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    if (isVersionCheckInProgress()) {
      return Response.json({
        message: 'Version check already in progress',
        checking: true,
        apps: await getAllInstalledApps(),
      });
    }

    await refreshVersionCheck();

    return Response.json({
      apps: await getAllInstalledApps(),
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
