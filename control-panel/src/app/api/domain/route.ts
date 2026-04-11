/**
 * Domain Configuration API
 * 
 * Manages the base domain for proxy routing.
 * Sets up TLS automation when domain is configured.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getConfiguredDomain, setDomain, checkHealth } from '@/lib/caddy/client';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { settingsService } from '@/lib/settings';

/**
 * GET /api/domain - Get the currently configured domain
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if Caddy is running
    const healthy = await checkHealth();
    if (!healthy) {
      return NextResponse.json({
        domain: null,
        caddyRunning: false,
      });
    }

    const domain = await getConfiguredDomain();
    
    return NextResponse.json({
      domain: domain || null,
      caddyRunning: true,
    });
  } catch (error) {
    console.error('Error getting domain:', error);
    return NextResponse.json(
      { 
        error: 'Failed to get domain configuration',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * POST /api/domain - Set the base domain for routing
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Verify CSRF token
    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const body = await request.json();
    const { domain } = body;

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json(
        { error: 'Domain is required' },
        { status: 400 }
      );
    }

    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z]{2,})+$/;
    if (!domainRegex.test(domain)) {
      return NextResponse.json(
        { error: 'Invalid domain format' },
        { status: 400 }
      );
    }

    // Check if Caddy is running
    const healthy = await checkHealth();
    if (!healthy) {
      return NextResponse.json(
        { error: 'Caddy is not running. Install and start Caddy first.' },
        { status: 503 }
      );
    }

    console.log(`[Domain] Setting domain to: ${domain} by ${session.username}`);
    
    // Get old domain before changing (for DNS cleanup)
    let oldDomain: string | undefined;
    try {
      const config = await settingsService.getRaw();
      oldDomain = config.domain || undefined;
    } catch {
      // Old domain unknown — cleanup will only target the new domain
    }

    await setDomain(domain);

    // Sync domain to Spine config
    try {
      await settingsService.setRaw({ domain });
    } catch (err) {
      console.error('[Domain] Failed to sync domain to Spine config:', err);
    }

    // Add Pi-Hole wildcard DNS rewrite (silently)
    try {
      const hostIP = process.env.HOST_IP;
      if (hostIP) {
        await setDomainDNS(domain, hostIP, oldDomain);
        console.log(`[Domain] Pi-Hole DNS rewrite set: *.${domain} → ${hostIP}`);
      }
    } catch (err) {
      console.error('[Domain] Failed to set Pi-Hole DNS rewrite:', err);
    }

    return NextResponse.json({
      success: true,
      domain,
      message: `Domain set to ${domain}. TLS certificate will be auto-generated.`,
    });
  } catch (error) {
    console.error('Error setting domain:', error);
    return NextResponse.json(
      { 
        error: 'Failed to set domain',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
