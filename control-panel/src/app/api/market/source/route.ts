import { catalogReleaseDisplay } from '@/lib/market/catalog-release';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { clearCatalogCache } from '@/lib/market/catalog';
import { getConfiguredMarketSources, getMarketSource, getMarketSources, isChannelMarketSource, setMarketSources, type MarketSource } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

// The official source shows its accepted catalog release; custom sources show their branch.
const display = async (item: MarketSource) => ({...item, release: isChannelMarketSource(item) ? await catalogReleaseDisplay() : null});

export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  try {
    const source = await getMarketSource();
    const sources = await getConfiguredMarketSources();
    const enabledSources = await getMarketSources();
    return NextResponse.json({ source:await display(source), sources:await Promise.all(sources.map(display)), enabledSources:await Promise.all(enabledSources.map(display)) });
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
      const enabledSources = sources.filter((source) => source.enabled);
      clearCatalogCache();
      return NextResponse.json({ status: 'ok', source: sources.length ? await display(enabledSources[0] || sources[0]) : undefined, sources:await Promise.all(sources.map(display)), enabledSources:await Promise.all(enabledSources.map(display)) });
    }

    return NextResponse.json({ error: 'active_sources is required' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update Market source' },
      { status: 400 },
    );
  }
}
