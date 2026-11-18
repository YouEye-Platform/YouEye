/**
 * POST /api/market/source/accept — { id }: the owner accepts an existing custom Market source. From then on its apps
 * may be installed, updated and switched to. Admin session with CSRF, or the CLI token
 * (`youeye market source accept <id>`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminCsrf } from '@/lib/auth/rbac';
import { clearCatalogCache } from '@/lib/market/catalog';
import { acceptMarketSource } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  try {
    const source = await acceptMarketSource(id);
    clearCatalogCache();
    console.log(`[Market] Source ${source.id} (${source.repo_url} ${source.branch}) accepted by ${auth.session.username}`);
    return NextResponse.json({ status: 'ok', source });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to accept Market source';
    return NextResponse.json({ error: message }, { status: /does not exist/.test(message) ? 404 : 400 });
  }
}
