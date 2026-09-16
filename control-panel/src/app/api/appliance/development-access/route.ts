import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

function routeError(error: unknown) {
  if (error instanceof SpineAPIError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
  }
  console.error('[development-access] Spine request failed:', error);
  return NextResponse.json({ error: 'Development access status is unavailable.' }, { status: 503 });
}

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await spineClient.getDevelopmentAccessStatus());
  } catch (error) {
    return routeError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!(await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? ''))) {
    return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }
  try {
    return NextResponse.json(await spineClient.disableDevelopmentAccess());
  } catch (error) {
    return routeError(error);
  }
}
