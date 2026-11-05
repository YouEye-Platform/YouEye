import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { getNamesReadiness, namesErrorMessage } from '@/lib/youeye-names/client';
import { discoverNamesService } from '@/lib/youeye-names/service';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  try {
    const [service, readiness] = await Promise.all([
      discoverNamesService(),
      getNamesReadiness(),
    ]);
    return NextResponse.json(
      { ok: true, reachable: true, service, readiness },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reachable: false,
        error: namesErrorMessage(error),
        readiness: {
          reachability: { reachable: false, state: 'unavailable' },
          installation: { canProceedNow: false, state: 'blocked', reasonCodes: ['service_unreachable'] },
        },
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }
}
