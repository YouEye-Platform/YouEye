/**
 * GET /api/setup/server-address (public, local setup surface only)
 *
 * The box's LAN IPv4 address. On `youeye.local` the page cannot read it from its own URL, and the DNS and
 * certificate instructions need the address itself.
 */
import { NextRequest, NextResponse } from 'next/server';
import { isLocalSetupHost } from '@/lib/auth/mode';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isLocalSetupHost(request.headers.get('host') || '')) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  const ip = process.env.HOST_IP || '';
  return NextResponse.json(
    { ip: /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? ip : null },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
