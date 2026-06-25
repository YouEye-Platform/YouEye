/**
 * UI Bridge: Clear Update Status
 *
 * POST /api/ui-bridge/updates/clear
 * Body: { component: string }
 *
 * Clears a completed/failed update status from the DB.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { clearStatus } from '@/lib/updates/state';

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const component = body.component;

    if (!component || typeof component !== 'string') {
      return NextResponse.json(
        { error: 'component is required' },
        { status: 400 }
      );
    }

    await clearStatus(component);
    return NextResponse.json({ status: 'ok' });
  } catch (err) {
    console.error('[UI Bridge] Clear status error:', err);
    return NextResponse.json(
      { error: 'Failed to clear status' },
      { status: 500 }
    );
  }
}
