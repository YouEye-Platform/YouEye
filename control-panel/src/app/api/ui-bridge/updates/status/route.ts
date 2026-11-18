/**
 * UI Bridge: Update Status
 *
 * GET /api/ui-bridge/updates/status
 *
 * Returns the unified update statuses (Spine + DB).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireEmbedAdmin } from '@/lib/ui-bridge/auth';
import { getUnifiedStatuses } from '@/lib/updates/state';

export async function GET(request: NextRequest) {
  const authError = await requireEmbedAdmin(request);
  if (authError) return authError;

  try {
    const statuses = await getUnifiedStatuses().catch(() => []);
    return NextResponse.json({ statuses });
  } catch (err) {
    console.error('[UI Bridge] Update status error:', err);
    return NextResponse.json(
      { error: 'Failed to get update statuses' },
      { status: 500 }
    );
  }
}
