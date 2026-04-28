/**
 * UI Bridge: Update Status
 *
 * GET /api/ui-bridge/updates/status
 *
 * Returns all active update statuses from the background queue +
 * legacy unified statuses (Spine + DB). The queue is the primary source
 * for updates initiated from YE-UI; legacy statuses cover Spine-managed
 * updates that bypass the queue.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getUnifiedStatuses } from '@/lib/updates/state';
import { getQueueStatus } from '@/lib/updates/queue';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const [statuses, queueEntries] = await Promise.all([
      getUnifiedStatuses().catch(() => []),
      getQueueStatus().catch(() => []),
    ]);

    return NextResponse.json({ statuses, queue: queueEntries });
  } catch (err) {
    console.error('[UI Bridge] Update status error:', err);
    return NextResponse.json(
      { error: 'Failed to get update statuses' },
      { status: 500 }
    );
  }
}
