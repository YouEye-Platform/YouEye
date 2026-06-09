import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { clearCatalogCache } from '@/lib/market/catalog';
import { getMarketSource, getMarketSources, setMarketSource, setMarketSources } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const source = await getMarketSource();
    const sources = await getMarketSources();
    return NextResponse.json({ source, sources });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to read Market source' },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const body = await request.json();
    if (Array.isArray(body?.active_sources)) {
      const sources = await setMarketSources(body.active_sources);
      clearCatalogCache();
      return NextResponse.json({ status: 'ok', source: sources[0], sources });
    }

    if (!body?.repo_url || typeof body.repo_url !== 'string') {
      return NextResponse.json({ error: 'repo_url or active_sources is required' }, { status: 400 });
    }

    const source = await setMarketSource(body.repo_url);
    clearCatalogCache();
    return NextResponse.json({ status: 'ok', source });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update Market source' },
      { status: 400 },
    );
  }
}
