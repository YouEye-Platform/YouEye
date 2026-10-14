import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { SpineAPIError } from '@/lib/spine/client';
import { readCoreUpdateStatus } from '@/lib/updates/core-guard';
export const dynamic = 'force-dynamic';
export async function GET() {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try { return NextResponse.json(await readCoreUpdateStatus(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) {
    const status = error instanceof SpineAPIError ? error.statusCode : 503;
    return NextResponse.json({ error: 'System update status is unavailable. Retained work needs reconciliation.' }, { status });
  }
}
