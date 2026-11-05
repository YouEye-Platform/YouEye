import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { SpineAPIError, spineClient } from '@/lib/spine/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    return NextResponse.json(await spineClient.getHostNetworkStatus());
  } catch (error) {
    if (error instanceof SpineAPIError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.statusCode });
    }
    console.error('[host-network] Spine request failed:', error);
    return NextResponse.json({ error: 'Host network status is unavailable.' }, { status: 503 });
  }
}
