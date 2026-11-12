import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';
import { isReleaseChannel } from '@/lib/releases/channel-index';

export const dynamic = 'force-dynamic';

/**
 * The box's release channel. Spine owns it (host release policy); the
 * Control Panel shows it and may ask Spine to follow another channel of the
 * same repository. The box never downgrades: on an older channel it waits for
 * that channel to catch up.
 */
export async function GET() {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await spineClient.getReleaseChannel(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Release channel unavailable' }, { status: error instanceof SpineAPIError ? error.statusCode : 503 });
  }
}

export async function PUT(request: NextRequest) {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? '')) return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || Object.keys(body).join(',') !== 'channel' || !isReleaseChannel(body.channel)) {
    return NextResponse.json({ error: 'channel must be one of dev, alpha, beta, stable' }, { status: 400 });
  }
  try {
    return NextResponse.json(await spineClient.setReleaseChannel(body.channel));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Release channel change failed' }, { status: error instanceof SpineAPIError ? error.statusCode : 503 });
  }
}
