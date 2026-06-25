/**
 * Pi-Hole Local DNS Records API
 *
 * Manage custom A and AAAA records for local DNS resolution
 * Updated for Pi-Hole FTL v6+ API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getDNSRecords, addDNSRecord, removeDNSRecord } from '@/lib/apps/pihole-api';

/**
 * GET - List custom DNS records
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const records = await getDNSRecords();

    return NextResponse.json({ records });
  } catch (error) {
    console.error('Error getting DNS records:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get DNS records' },
      { status: 500 }
    );
  }
}

/**
 * POST - Add DNS record
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

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }

    const { domain, ip } = await request.json();

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    if (!ip || typeof ip !== 'string') {
      return NextResponse.json({ error: 'IP address is required' }, { status: 400 });
    }

    // Validate IP format (IPv4 or IPv6)
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;

    if (!ipv4Regex.test(ip) && !ipv6Regex.test(ip)) {
      return NextResponse.json({ error: 'Invalid IP address format' }, { status: 400 });
    }

    // Validate IPv4 octets
    if (ipv4Regex.test(ip)) {
      const octets = ip.split('.').map(Number);
      if (octets.some((o) => o < 0 || o > 255)) {
        return NextResponse.json({ error: 'Invalid IP address' }, { status: 400 });
      }
    }

    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
    if (!domainRegex.test(domain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
    }

    await addDNSRecord(domain, ip);

    console.log(`[Pi-Hole] DNS record added: ${domain} → ${ip} by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: 'DNS record added',
    });
  } catch (error) {
    console.error('Error adding DNS record:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add DNS record' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove DNS record
 */
export async function DELETE(request: NextRequest) {
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

    const { domain, ip } = await request.json();

    if (!domain || !ip) {
      return NextResponse.json({ error: 'Domain and IP are required' }, { status: 400 });
    }

    await removeDNSRecord(domain, ip);

    console.log(`[Pi-Hole] DNS record removed: ${domain} → ${ip} by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: 'DNS record removed',
    });
  } catch (error) {
    console.error('Error removing DNS record:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove DNS record' },
      { status: 500 }
    );
  }
}
