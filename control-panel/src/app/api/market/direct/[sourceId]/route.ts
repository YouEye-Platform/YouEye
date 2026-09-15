import { type NextRequest, NextResponse } from 'next/server';

import { requireAdmin } from '@/lib/auth/rbac';
import { getDirectMarketApp, removeDirectMarketApp } from '@/lib/market/direct-apps';
import { getInstalledApp } from '@/lib/market/installed-apps';

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { sourceId } = await params;
  const entry = await getDirectMarketApp(sourceId);
  if (!entry) return NextResponse.json({ error: 'Added app not found' }, { status: 404 });
  const installed = await getInstalledApp(entry.manifest.metadata.id);
  if (installed?.sourceId === sourceId) {
    return NextResponse.json({ error: 'Uninstall this app before removing it from Market' }, { status: 409 });
  }
  await removeDirectMarketApp(sourceId);
  return NextResponse.json({ status: 'removed' });
}
