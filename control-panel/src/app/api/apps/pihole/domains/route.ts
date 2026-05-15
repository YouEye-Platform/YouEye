/**
 * Pi-Hole Domains API
 *
 * Manage whitelist and blacklist domains
 * Updated for Pi-Hole FTL v6+ API
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getDomainLists, addDomain, removeDomain } from '@/lib/apps/pihole-api';

/**
 * GET - List whitelist and blacklist
 */
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const listType = request.nextUrl.searchParams.get('type') || 'all';
    const lists = await getDomainLists();

    if (listType === 'white') {
      return NextResponse.json({ domains: lists.whitelist });
    } else if (listType === 'black') {
      return NextResponse.json({ domains: lists.blacklist });
    }

    return NextResponse.json({
      whitelist: lists.whitelist,
      blacklist: lists.blacklist,
    });
  } catch (error) {
    console.error('Error getting Pi-Hole domains:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get domains' },
      { status: 500 }
    );
  }
}

/**
 * POST - Add domain to whitelist or blacklist
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

    const { domain, type } = await request.json();

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Invalid domain' }, { status: 400 });
    }

    if (!['white', 'black'].includes(type)) {
      return NextResponse.json({ error: 'Type must be "white" or "black"' }, { status: 400 });
    }

    const listType = type === 'white' ? 'whitelist' : 'blacklist';
    await addDomain(domain, listType);

    console.log(`[Pi-Hole] Domain ${domain} added to ${type}list by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: `Domain added to ${type}list`,
    });
  } catch (error) {
    console.error('Error adding domain:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add domain' },
      { status: 500 }
    );
  }
}

/**
 * DELETE - Remove domain from whitelist or blacklist
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

    const { domain, type } = await request.json();

    if (!domain || typeof domain !== 'string') {
      return NextResponse.json({ error: 'Invalid domain' }, { status: 400 });
    }

    if (!['white', 'black'].includes(type)) {
      return NextResponse.json({ error: 'Type must be "white" or "black"' }, { status: 400 });
    }

    const listType = type === 'white' ? 'whitelist' : 'blacklist';
    await removeDomain(domain, listType);

    console.log(`[Pi-Hole] Domain ${domain} removed from ${type}list by ${session.username}`);
    return NextResponse.json({
      success: true,
      message: `Domain removed from ${type}list`,
    });
  } catch (error) {
    console.error('Error removing domain:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to remove domain' },
      { status: 500 }
    );
  }
}
