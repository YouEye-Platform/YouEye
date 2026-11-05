/**
 * UI Bridge: DNS Configuration
 *
 * GET   /api/ui-bridge/dns/config — get DNS config
 * PATCH /api/ui-bridge/dns/config — update DNS config
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { piholeRequest } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const config = await piholeRequest<Record<string, unknown>>('/api/config/dns');
    return NextResponse.json({ config });
  } catch (err) {
    console.error('[UI Bridge] DNS config GET error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve DNS configuration' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { config } = body as { config: Record<string, unknown> };

    if (!config || typeof config !== 'object') {
      return NextResponse.json(
        { error: 'Missing required field: config (object)' },
        { status: 400 }
      );
    }

    const result = await piholeRequest<Record<string, unknown>>('/api/config/dns', {
      method: 'PATCH',
      body: JSON.stringify({ config: { dns: config } }),
    });

    console.log('[UI Bridge] DNS config updated');
    return NextResponse.json({ success: true, config: result });
  } catch (err) {
    console.error('[UI Bridge] DNS config PATCH error:', err);
    return NextResponse.json(
      { error: 'Failed to update DNS configuration' },
      { status: 500 }
    );
  }
}
