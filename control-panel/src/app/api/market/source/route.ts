/**
 * Market sources.
 *
 * GET   /api/market/source  — every source (official first by priority), with `accepted_at` for custom ones.
 * POST  /api/market/source  — add a custom source: { repo_url, branch?, name?, id?, acceptRisk: true }. The owner's
 *                             consent is the `acceptRisk` tick, so the new source is accepted at once.
 * PATCH /api/market/source  — { active_sources: [...] }: enable, disable, rename, reorder or remove existing sources.
 *                             It cannot add one or accept one; a changed address or branch drops the acceptance.
 *
 * Accepting an existing source: POST /api/market/source/accept. Admin session with CSRF, or the CLI token.
 */
import { catalogReleaseDisplay } from '@/lib/market/catalog-release';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireAdminCsrf } from '@/lib/auth/rbac';
import { clearCatalogCache } from '@/lib/market/catalog';
import {
  addMarketSource, getConfiguredMarketSources, isChannelMarketSource, updateMarketSourceList, type MarketSource,
} from '@/lib/market/source';

export const dynamic = 'force-dynamic';

// The official source shows its accepted catalog release; custom sources show their branch.
const display = async (item: MarketSource) => ({...item, release: isChannelMarketSource(item) ? await catalogReleaseDisplay() : null});
const listing = async (sources: MarketSource[]) => ({ sources: await Promise.all(sources.map(display)) });

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    return NextResponse.json(await listing(await getConfiguredMarketSources()));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read Market source' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || typeof body.repo_url !== 'string' || !body.repo_url.trim()) {
    return NextResponse.json({ error: 'repo_url is required' }, { status: 400 });
  }
  if (body.acceptRisk !== true) {
    return NextResponse.json({
      error: 'Apps from this source are not checked by YouEye. They run their own setup steps on your box. '
        + 'Add only sources you trust, and confirm it (acceptRisk: true).',
      code: 'source-not-accepted',
    }, { status: 400 });
  }
  for (const field of ['branch', 'name', 'id'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return NextResponse.json({ error: `${field} must be text` }, { status: 400 });
    }
  }
  try {
    const source = await addMarketSource({ repo_url: body.repo_url, branch: body.branch, name: body.name, id: body.id });
    clearCatalogCache();
    console.log(`[Market] Source ${source.id} (${source.repo_url} ${source.branch}) added and accepted by ${auth.session.username}`);
    return NextResponse.json({ status: 'ok', source: await display(source), ...await listing(await getConfiguredMarketSources()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to add Market source' }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    if (Array.isArray(body?.active_sources)) {
      const sources = await updateMarketSourceList(body.active_sources);
      clearCatalogCache();
      return NextResponse.json({ status: 'ok', ...await listing(sources) });
    }

    return NextResponse.json({ error: 'active_sources is required' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update Market source' },
      { status: 400 },
    );
  }
}
