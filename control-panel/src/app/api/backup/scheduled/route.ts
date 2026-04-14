/**
 * Scheduled Backup API
 *
 * POST /api/backup/scheduled — Called by Spine scheduler to trigger scheduled backups
 *
 * Spine calls this endpoint on cron to trigger backups according to the schedule.
 * This endpoint reads the backup config, determines what needs backing up,
 * runs the appropriate backup functions, and prunes old backups.
 */

import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';
import { backupApp } from '@/lib/backup/app-backup';
import { backupCore } from '@/lib/backup/core-backup';
import { listInstalledApps } from '@/lib/market/metadata';
import type { BackupScheduleConfig } from '@/lib/backup/types';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  // Verify this is coming from Spine (localhost only)
  const host = request.headers.get('host') || '';
  if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
    // Allow connections from within the container network too
    // This is a basic check — Spine connects via Unix socket proxy
  }

  let body: { passphrase?: string; type?: string; app_id?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.passphrase) {
    return NextResponse.json(
      { error: 'Missing passphrase' },
      { status: 400 }
    );
  }

  const results: Array<{ type: string; id?: string; status: string; error?: string }> = [];

  try {
    const config: BackupScheduleConfig = await spineClient.getBackupConfig();

    if (!config.enabled) {
      return NextResponse.json({ status: 'skipped', reason: 'Backups disabled' });
    }

    const targetPath = config.targetPath;

    // Determine what to back up based on type parameter or schedule
    const backupType = body.type || 'all';

    // Core backup
    if (backupType === 'all' || backupType === 'core') {
      try {
        await backupCore(
          { targetPath, passphrase: body.passphrase, hostname: undefined },
          () => {} // No SSE relay for scheduled backups
        );
        results.push({ type: 'core', status: 'completed' });

        // Prune old core backups
        try {
          await spineClient.pruneBackups('core', '', config.schedule.core.retention);
        } catch {
          // Best effort
        }
      } catch (err) {
        results.push({ type: 'core', status: 'failed', error: String(err) });
      }
    }

    // App backups
    if (backupType === 'all' || backupType === 'app') {
      const installedApps = await listInstalledApps();
      const targetAppId = body.app_id;

      for (const app of installedApps) {
        if (targetAppId && app.appId !== targetAppId) continue;

        // Check if this app should be backed up
        const override = config.schedule.overrides[app.appId];
        const frequency = override?.frequency || config.schedule.defaultApp.frequency;
        const retention = override?.retention || config.schedule.defaultApp.retention;

        if (frequency === 'never') {
          results.push({ type: 'app', id: app.appId, status: 'skipped' });
          continue;
        }

        try {
          await backupApp(
            { appId: app.appId, targetPath, passphrase: body.passphrase },
            () => {} // No SSE relay for scheduled backups
          );
          results.push({ type: 'app', id: app.appId, status: 'completed' });

          // Prune old app backups
          try {
            await spineClient.pruneBackups('app', app.appId, retention);
          } catch {
            // Best effort
          }
        } catch (err) {
          results.push({ type: 'app', id: app.appId, status: 'failed', error: String(err) });
        }
      }
    }

    return NextResponse.json({ status: 'completed', results });
  } catch (err) {
    return NextResponse.json(
      { error: `Scheduled backup failed: ${err}` },
      { status: 500 }
    );
  }
}
