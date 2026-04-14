/**
 * UI Bridge: Backup & Restore
 *
 * GET  /api/ui-bridge/backup — returns backup config + index (history)
 * POST /api/ui-bridge/backup — save backup configuration
 *
 * The UI admin backup page calls these through the /api/admin/* proxy.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { spineClient } from '@/lib/spine/client';
import { listInstalledApps } from '@/lib/market/metadata';

export async function GET(request: NextRequest) {
  const valid = await validateBridgeToken(request);
  if (!valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Fetch backup config from Spine
    let config = null;
    try {
      config = await spineClient.getBackupConfig();
    } catch {
      // Spine may not have backup config yet — return defaults
    }

    // Fetch backup index from Spine
    let index = null;
    try {
      index = await spineClient.getBackupList();
    } catch {
      // No backups yet
    }

    // Fetch installed apps for the schedule table
    let apps: Array<{ appId: string; type: string; subdomain?: string; installedVersion?: string }> = [];
    try {
      apps = (await listInstalledApps()).map(a => ({
        appId: a.appId,
        type: a.type || 'marketplace',
        subdomain: a.subdomain,
        installedVersion: a.installedVersion,
      }));
    } catch {
      // No apps installed
    }

    return NextResponse.json({
      config: config || {
        enabled: false,
        target_path: '/mnt/backup',
        schedule: {
          core: { frequency: 'daily', retention: 7, time: '03:00' },
          default_app: { frequency: 'daily', retention: 7 },
          overrides: {},
        },
      },
      index,
      apps,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to fetch backup data: ${err}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const valid = await validateBridgeToken(request);
  if (!valid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    await spineClient.setBackupConfig(body);
    return NextResponse.json({ status: 'ok' });
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to save backup config: ${err}` },
      { status: 500 }
    );
  }
}
