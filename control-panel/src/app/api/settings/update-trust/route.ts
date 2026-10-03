import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { loadOwnerTrust, saveOwnerTrust, validateOwnerTrust } from '@/lib/releases/owner-trust';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try { return NextResponse.json(loadOwnerTrust()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read trust policy' }, { status: 500 }); }
}
export async function PUT(request: NextRequest) {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    const raw = await request.text();
    if (raw.length > 1024 * 1024) throw new Error('Trust policy too large');
    const policy = validateOwnerTrust(JSON.parse(raw));
    if (policy.grants.some(g => g.scope !== 'app' && g.scope !== 'ui')) throw new Error('Control Panel may enroll only app and UI publishers; host trust requires the host owner CLI');
    await saveOwnerTrust(policy);
    return NextResponse.json(policy);
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid trust policy' }, { status: 400 }); }
}
