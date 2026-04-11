/**
 * UI Bridge: Update Status
 *
 * GET /api/ui-bridge/updates/status
 *
 * Returns all active update statuses (aggregated from Spine + DB).
 * Used by YE-UI to show persistent update progress that survives page refresh.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getUnifiedStatuses } from '@/lib/updates/state';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const statuses = await getUnifiedStatuses();
    return NextResponse.json({ statuses });
  } catch (err) {
    console.error('[UI Bridge] Update status error:', err);
    return NextResponse.json(
      { error: 'Failed to get update statuses' },
      { status: 500 }
    );
  }
}
