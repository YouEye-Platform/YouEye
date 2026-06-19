import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getStagedByoDomainBundle, safeByoDomainBundleSummary } from '@/lib/byo-domain/bundle';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const bundle = await getStagedByoDomainBundle();
  return NextResponse.json(safeByoDomainBundleSummary(bundle), {
    headers: { 'cache-control': 'no-store' },
  });
}
