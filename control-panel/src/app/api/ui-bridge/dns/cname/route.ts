/**
 * UI Bridge: DNS CNAME Records
 *
 * GET    /api/ui-bridge/dns/cname — list CNAME records
 * POST   /api/ui-bridge/dns/cname — add a CNAME record
 * DELETE /api/ui-bridge/dns/cname — remove a CNAME record
 */

import { NextRequest, NextResponse } from 'next/server';
import { validateBridgeToken } from '@/lib/ui-bridge/auth';
import { getCNAMERecords, addCNAMERecord, removeCNAMERecord } from '@/lib/apps/pihole-api';

export async function GET(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const records = await getCNAMERecords();
    return NextResponse.json({ records });
  } catch (err) {
    console.error('[UI Bridge] DNS CNAME GET error:', err);
    return NextResponse.json(
      { error: 'Failed to retrieve CNAME records' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { domain, target } = body as { domain: string; target: string };

    if (!domain || !target) {
      return NextResponse.json(
        { error: 'Missing required fields: domain, target' },
        { status: 400 }
      );
    }

    await addCNAMERecord(domain, target);

    console.log(`[UI Bridge] Added CNAME record: ${domain} -> ${target}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS CNAME POST error:', err);
    return NextResponse.json(
      { error: 'Failed to add CNAME record' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await validateBridgeToken(request);
  if (authError) return authError;

  try {
    const body = await request.json();
    const { domain, target } = body as { domain: string; target: string };

    if (!domain || !target) {
      return NextResponse.json(
        { error: 'Missing required fields: domain, target' },
        { status: 400 }
      );
    }

    await removeCNAMERecord(domain, target);

    console.log(`[UI Bridge] Removed CNAME record: ${domain} -> ${target}`);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[UI Bridge] DNS CNAME DELETE error:', err);
    return NextResponse.json(
      { error: 'Failed to remove CNAME record' },
      { status: 500 }
    );
  }
}
