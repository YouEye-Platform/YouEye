/**
 * UI Bridge: DNS History
 *
 * GET /api/ui-bridge/dns/history
 *
 * Returns over-time query data for charts.
 * Each entry has: timestamp, total, cached, blocked, forwarded.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { piholeRequest } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const data = await piholeRequest<{
      history: Array<{ timestamp: number; total: number; cached: number; blocked: number; forwarded: number }>;
    }>('/api/history');

    return NextResponse.json({ history: data.history || [] });
  } catch (err) {
    console.error('[UI Bridge] DNS history error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve DNS history' },
      { status: 500 }
    );
  }
}
