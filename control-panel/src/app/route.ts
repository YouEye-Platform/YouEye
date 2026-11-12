import { NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';

export const dynamic = 'force-dynamic';

// Normal Control Panel root navigation is handled by middleware. Identity-only
// mode uses this landing route so a completed login/logout never ends at a 404.
export async function GET() {
  const config = await getIdentityConfig();
  return NextResponse.redirect(config.dashboardUrl, {
    status: 303,
    headers: { 'Cache-Control': 'no-store' },
  });
}
