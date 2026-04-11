/**
 * Backup Status API — polls Spine for current backup status.
 *
 * GET /api/backup/status
 *
 * Returns the current backup status from Spine's backup-status.json file.
 */

import { NextRequest } from 'next/server';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest) {
  try {
    const status = await spineClient.getBackupStatus();
    return new Response(JSON.stringify(status), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to get backup status: ${err}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
