/**
 * UI Bridge: DNS Upstream Servers
 *
 * GET  /api/ui-bridge/dns/upstream — list current upstream DNS servers
 * PUT  /api/ui-bridge/dns/upstream — replace upstream DNS servers list
 *
 * Proxies to the existing pihole-api library.
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getUpstreamDNS, setUpstreamDNS } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const upstreams = await getUpstreamDNS();
    return NextResponse.json({ upstreams });
  } catch (err) {
    console.error('[UI Bridge] DNS upstream GET error:', err);
    return NextResponse.json(
      { error: 'Failed to get upstream DNS servers' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const { upstreams } = await request.json();

    if (!Array.isArray(upstreams) || upstreams.length === 0) {
      return NextResponse.json(
        { error: 'upstreams must be a non-empty array of strings' },
        { status: 400 }
      );
    }

    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    const ipPortRegex = /^(\d{1,3}\.){3}\d{1,3}#\d+$/;

    for (const server of upstreams) {
      const trimmed = String(server).trim();
      if (!ipv4Regex.test(trimmed) && !ipv6Regex.test(trimmed) && !ipPortRegex.test(trimmed)) {
        return NextResponse.json(
          { error: `Invalid upstream format: ${trimmed}` },
          { status: 400 }
        );
      }
    }

    const unique = [...new Set(upstreams.map((s: string) => s.trim()))];
    const result = await setUpstreamDNS(unique);

    console.log(`[UI Bridge] Upstream DNS updated to [${unique.join(', ')}]`);
    return NextResponse.json({ success: true, upstreams: result });
  } catch (err) {
    console.error('[UI Bridge] DNS upstream PUT error:', err);
    return NextResponse.json(
      { error: 'Failed to update upstream DNS servers' },
      { status: 500 }
    );
  }
}
