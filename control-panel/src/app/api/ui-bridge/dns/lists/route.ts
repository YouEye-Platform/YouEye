/**
 * UI Bridge: DNS Blocklists (Adlists)
 *
 * GET    /api/ui-bridge/dns/lists — list all adlists
 * POST   /api/ui-bridge/dns/lists — add an adlist
 * DELETE /api/ui-bridge/dns/lists — remove an adlist
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { piholeRequest } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const data = await piholeRequest<{ lists: unknown[] }>('/api/lists');
    return NextResponse.json({ lists: data.lists || [] });
  } catch (err) {
    console.error('[UI Bridge] DNS lists GET error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve blocklists' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { address, comment, type } = body as {
      address: string;
      comment?: string;
      type?: string;
    };

    if (!address) {
      return NextResponse.json(
        { error: 'Missing required field: address' },
        { status: 400 }
      );
    }

    const listType = type || 'block';

    await piholeRequest(`/api/lists?type=${listType}`, {
      method: 'POST',
      body: JSON.stringify({
        address,
        comment: comment || '',
        enabled: true,
        groups: [0],
      }),
    });

    console.log(`[UI Bridge] Added ${listType} list: ${address}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS lists POST error:', err);
    return NextResponse.json(
      { error: 'Failed to add blocklist' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { address, type } = body as {
      address: string;
      type?: string;
    };

    if (!address) {
      return NextResponse.json(
        { error: 'Missing required field: address' },
        { status: 400 }
      );
    }

    const listType = type || 'block';

    await piholeRequest(
      `/api/lists/${encodeURIComponent(address)}?type=${listType}`,
      { method: 'DELETE' }
    );

    console.log(`[UI Bridge] Removed ${listType} list: ${address}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS lists DELETE error:', err);
    return NextResponse.json(
      { error: 'Failed to remove blocklist' },
      { status: 500 }
    );
  }
}
