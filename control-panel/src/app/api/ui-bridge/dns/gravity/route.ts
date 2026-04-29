/**
 * UI Bridge: DNS Gravity Update
 *
 * POST /api/ui-bridge/dns/gravity
 *
 * Triggers a Pi-Hole gravity update (re-download and process blocklists).
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { piholeRequest } from '@/lib/apps/pihole-api';

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    await piholeRequest('/api/action/gravity', { method: 'POST' });

    console.log('[UI Bridge] Gravity update triggered');
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS gravity error:', err);
    return NextResponse.json(
      { error: 'Failed to trigger gravity update' },
      { status: 500 }
    );
  }
}
