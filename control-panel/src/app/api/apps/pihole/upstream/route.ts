/**
 * Pi-Hole Upstream DNS Servers API
 *
 * Manage which upstream DNS resolvers Pi-Hole forwards queries to.
 * Uses Pi-Hole FTL v6 /api/config/dns { upstreams: string[] }
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getUpstreamDNS, setUpstreamDNS } from '@/lib/apps/pihole-api';

/**
 * GET - List current upstream DNS servers
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const upstreams = await getUpstreamDNS();

    return NextResponse.json({ upstreams });
  } catch (error) {
    console.error('Error getting upstream DNS servers:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get upstream DNS servers' },
      { status: 500 }
    );
  }
}

/**
 * PUT - Replace upstream DNS servers list
 */
export async function PUT(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { upstreams } = await request.json();

    if (!Array.isArray(upstreams)) {
      return NextResponse.json({ error: 'upstreams must be an array of strings' }, { status: 400 });
    }

    if (upstreams.length === 0) {
      return NextResponse.json({ error: 'At least one upstream DNS server is required' }, { status: 400 });
    }

    // Validate each entry is a valid IP or IP#port
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    const ipPortRegex = /^(\d{1,3}\.){3}\d{1,3}#\d+$/;

    for (const server of upstreams) {
      if (typeof server !== 'string') {
        return NextResponse.json({ error: 'Each upstream must be a string' }, { status: 400 });
      }

      const trimmed = server.trim();
      if (!ipv4Regex.test(trimmed) && !ipv6Regex.test(trimmed) && !ipPortRegex.test(trimmed)) {
        return NextResponse.json(
          { error: `Invalid upstream DNS server format: ${trimmed}` },
          { status: 400 }
        );
      }

      // Validate IPv4 octets
      const ipPart = trimmed.split('#')[0];
      if (ipv4Regex.test(ipPart) || ipPortRegex.test(trimmed)) {
        const octets = ipPart.split('.').map(Number);
        if (octets.some((o) => o < 0 || o > 255)) {
          return NextResponse.json({ error: `Invalid IP address: ${trimmed}` }, { status: 400 });
        }
      }
    }

    // Deduplicate
    const unique = [...new Set(upstreams.map((s: string) => s.trim()))];

    const result = await setUpstreamDNS(unique);

    console.log(`[Pi-Hole] Upstream DNS servers updated to [${unique.join(', ')}] by ${session.username}`);
    return NextResponse.json({
      success: true,
      upstreams: result,
    });
  } catch (error) {
    console.error('Error updating upstream DNS servers:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update upstream DNS servers' },
      { status: 500 }
    );
  }
}
