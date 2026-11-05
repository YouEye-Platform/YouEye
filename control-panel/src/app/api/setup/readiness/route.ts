import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { requireSetupReadiness } from '@/lib/setup/readiness';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Administrator access required' }, { status: 403 });
  try {
    await requireSetupReadiness();
    return NextResponse.json({ ready: true, evidence: 'retained-installed-acceptance' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: 'Installed System acceptance is unavailable or conflicts with setup. Reconcile the existing update or recovery, then retry.' }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
  }
}
