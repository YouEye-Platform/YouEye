/**
 * Backup List API
 *
 * GET /api/backup/list — Get the backup index (available backups)
 *
 * Query params:
 * - type: "core" | "app" (optional filter)
 * - app_id: filter by app ID (optional, only for type=app)
 */

import { NextRequest, NextResponse } from 'next/server';
import { spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || undefined;
  const appId = searchParams.get('app_id') || undefined;

  try {
    const index = await spineClient.getBackupList(type, appId);
    return NextResponse.json(index);
  } catch (err) {
    return NextResponse.json(
      { error: `Failed to get backup list: ${err}` },
      { status: 500 }
    );
  }
}
