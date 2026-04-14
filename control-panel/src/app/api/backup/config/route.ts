/**
 * Backup Config API
 *
 * GET  /api/backup/config — Get backup schedule configuration
 * POST /api/backup/config — Update backup schedule configuration
 *
 * Configuration is stored on the Spine side (youeye.yaml or dedicated config).
 */

import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const config = await spineClient.getBackupConfig();
    return NextResponse.json(config);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to get backup config: ${err}` },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  // Validate required fields
  if (typeof body.enabled !== 'boolean' || !body.targetPath || !body.schedule) {
    return NextResponse.json(
      { error: 'Missing required fields: enabled, targetPath, schedule' },
      { status: 400 }
    );
  }

  try {
    const result = await spineClient.setBackupConfig(
      body as unknown as import('@/lib/backup/types').BackupScheduleConfig
    );
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to set backup config: ${err}` },
      { status: 500 }
    );
  }
}
