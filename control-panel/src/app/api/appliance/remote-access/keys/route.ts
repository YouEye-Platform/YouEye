import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

function routeError(error: unknown) {
  if (error instanceof SpineAPIError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
  }
  console.error('[remote-access] Spine request failed:', error);
  return NextResponse.json({ error: 'Remote access settings are unavailable.' }, { status: 503 });
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await spineClient.getRemoteAccessKeys());
  } catch (error) {
    return routeError(error);
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body.public_key !== 'string' || !body.public_key.trim()) {
    return NextResponse.json({ error: 'A public key is required.' }, { status: 400 });
  }
  try {
    return NextResponse.json(await spineClient.addRemoteAccessKey(body.public_key), { status: 201 });
  } catch (error) {
    return routeError(error);
  }
}
