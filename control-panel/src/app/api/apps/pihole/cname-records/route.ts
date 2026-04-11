/**
 * Pi-Hole Local CNAME Records API
 *
 * Manage CNAME records for local DNS resolution
 * Updated for Pi-Hole FTL v6+ API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getCNAMERecords, addCNAMERecord, removeCNAMERecord } from '@/lib/apps/pihole-api';

/**
 * GET - List CNAME records
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const records = await getCNAMERecords();

    return NextResponse.json({ records });
  } catch (error) {
    console.error('Error getting CNAME records:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get CNAME records' },
      { status: 500 }
    );
  }
}

/**
 * POST - Add CNAME record
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

    const { domain, target } = await request.json();

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    if (!target || typeof target !== 'string') {
      return NextResponse.json({ error: 'Target hostname is required' }, { status: 400 });
    }

    // Validate domain format
    const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/;
    if (!domainRegex.test(domain)) {
      return NextResponse.json({ error: 'Invalid domain format' }, { status: 400 });
    }

    if (!domainRegex.test(target)) {
      return NextResponse.json({ error: 'Invalid target format' }, { status: 400 });
    }

    await addCNAMERecord(domain, target);

    console.log(`[Pi-Hole] CNAME record added: ${domain} → ${target} by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: 'CNAME record added',
    });
  } catch (error) {
    console.error('Error adding CNAME record:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add CNAME record' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove CNAME record
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

    const { domain, target } = await request.json();

    if (!domain || !target) {
      return NextResponse.json({ error: 'Domain and target are required' }, { status: 400 });
    }

    await removeCNAMERecord(domain, target);

    console.log(`[Pi-Hole] CNAME record removed: ${domain} → ${target} by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: 'CNAME record removed',
    });
  } catch (error) {
    console.error('Error removing CNAME record:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove CNAME record' },
      { status: 500 }
    );
  }
}
