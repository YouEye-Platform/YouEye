/** GET /api/setup/names/status — `{name, fqdn, stage, running, error}` of the YouEye Names job. */
import { NextRequest, NextResponse } from 'next/server';
import { requireSetupSession } from '@/lib/setup/session';
import { namesJobStatus } from '@/lib/youeye-names/provision';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireSetupSession(request, { csrf: false });
  if (auth.response) return auth.response;
  try {
    return NextResponse.json(await namesJobStatus(), { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json(
      { error: 'YouEye Names lifecycle state is damaged or has unsafe permissions.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
