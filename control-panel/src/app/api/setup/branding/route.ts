import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { GET as readBranding } from '@/app/api/ui/branding/route';

export const dynamic = 'force-dynamic';

/** Read the saved appearance without opening the UI bridge to setup sessions. */
export async function GET() {
  if (!(await getSession())?.isAdmin) {
    return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  }
  return readBranding();
}
