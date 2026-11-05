import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { syncInstalledAppManifestToUI } from '@/lib/market/ui-manifest-sync';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> },
) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const { appId } = await params;
  if (!appId) {
    return NextResponse.json({ error: 'appId is required' }, { status: 400 });
  }

  try {
    const result = await syncInstalledAppManifestToUI(appId);
    return NextResponse.json({ status: 'ok', ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes('is not installed') ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
