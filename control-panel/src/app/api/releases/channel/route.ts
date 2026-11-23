import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';
import { isReleaseChannel } from '@/lib/releases/channel-index';

export const dynamic = 'force-dynamic';

/**
 * The box's release channel and repository. Spine owns them (host release
 * policy); the Control Panel shows them and lets an admin ask Spine to follow
 * another channel or another repository. Spine checks a new repository (its
 * channel index must name it and list YouEye) and refuses before the first
 * deploy. The box never downgrades: on an older channel it waits for that
 * channel to catch up.
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
  const keys = body ? Object.keys(body).sort().join(',') : '';
  if (!body || (keys !== 'channel' && keys !== 'channel,repository') || !isReleaseChannel(body.channel)) {
    return NextResponse.json({ error: 'channel must be one of dev, alpha, beta, stable' }, { status: 400 });
  }
  const repository = body.repository;
  if (repository !== undefined && (typeof repository !== 'string' || repository.length === 0 || repository.length > 2048)) {
    return NextResponse.json({ error: 'repository must be an https://host/owner/repository address' }, { status: 400 });
  }
  try {
    return NextResponse.json(await spineClient.setReleaseChannel(body.channel, repository));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Release channel change failed' }, { status: error instanceof SpineAPIError ? error.statusCode : 503 });
  }
}
