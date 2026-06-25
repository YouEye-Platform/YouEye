/**
 * UI Bridge: DNS Control
 *
 * POST /api/ui-bridge/dns/control
 *
 * Enable or disable Pi-Hole DNS blocking.
 * Reuses the existing pihole-api library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { setBlocking } from '@/lib/apps/pihole-api';

const VALID_ACTIONS = ['enable', 'disable'] as const;
type DnsAction = (typeof VALID_ACTIONS)[number];

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const action = body.action as string;

    if (!action || !VALID_ACTIONS.includes(action as DnsAction)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid action. Must be one of: ${VALID_ACTIONS.join(', ')}`,
        },
        { status: 400 }
      );
    }

    const enabled = action === 'enable';
    await setBlocking(enabled);

    console.log(`[UI Bridge] DNS blocking ${action}d`);

    return NextResponse.json({
      success: true,
      status: enabled ? 'enabled' : 'disabled',
    });
  } catch (err) {
    console.error('[UI Bridge] DNS control error:', err);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to control DNS blocking',
      },
      { status: 500 }
    );
  }
}
