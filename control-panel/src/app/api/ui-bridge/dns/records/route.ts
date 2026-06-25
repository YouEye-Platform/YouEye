/**
 * UI Bridge: DNS A/AAAA Records
 *
 * GET    /api/ui-bridge/dns/records — list DNS records
 * POST   /api/ui-bridge/dns/records — add a DNS record
 * DELETE /api/ui-bridge/dns/records — remove a DNS record
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getDNSRecords, addDNSRecord, removeDNSRecord } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const records = await getDNSRecords();
    return NextResponse.json({ records });
  } catch (err) {
    console.error('[UI Bridge] DNS records GET error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve DNS records' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { ip, domain } = body as { ip: string; domain: string };

    if (!ip || !domain) {
      return NextResponse.json(
        { error: 'Missing required fields: ip, domain' },
        { status: 400 }
      );
    }

    await addDNSRecord(ip, domain);

    console.log(`[UI Bridge] Added DNS record: ${domain} -> ${ip}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS records POST error:', err);
    return NextResponse.json(
      { error: 'Failed to add DNS record' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { ip, domain } = body as { ip: string; domain: string };

    if (!ip || !domain) {
      return NextResponse.json(
        { error: 'Missing required fields: ip, domain' },
        { status: 400 }
      );
    }

    await removeDNSRecord(ip, domain);

    console.log(`[UI Bridge] Removed DNS record: ${domain} -> ${ip}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS records DELETE error:', err);
    return NextResponse.json(
      { error: 'Failed to remove DNS record' },
      { status: 500 }
    );
  }
}
