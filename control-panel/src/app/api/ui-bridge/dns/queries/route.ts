/**
 * UI Bridge: DNS Queries
 *
 * GET /api/ui-bridge/dns/queries
 *
 * Returns query log entries with optional filtering.
 * Accepts query params: limit, domain, client, status, type, blocked.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { piholeRequest } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const { searchParams } = new URL(request.url);
    const limit = searchParams.get('limit') || '100';
    const domain = searchParams.get('domain');
    const client = searchParams.get('client');
    const status = searchParams.get('status');
    const type = searchParams.get('type');
    const blocked = searchParams.get('blocked');

    const params = new URLSearchParams();
    params.set('length', limit);
    if (domain) params.set('domain', domain);
    if (client) params.set('client', client);
    if (status) params.set('status', status);
    if (type) params.set('type', type);
    if (blocked) params.set('blocked', blocked);

    const data = await piholeRequest<{ queries: unknown[] }>(
      `/api/queries?${params.toString()}`
    );

    return NextResponse.json({ queries: data.queries || [] });
  } catch (err) {
    console.error('[UI Bridge] DNS queries error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve DNS queries' },
      { status: 500 }
    );
  }
}
