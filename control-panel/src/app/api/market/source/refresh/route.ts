/**
 * POST /api/market/source/refresh — { id? }: ask the markets again now (the named source, or every enabled one) and
 * wait for the answers, 20 seconds at most. Each market costs one conditional request when nothing changed; a changed
 * market costs its index and the bundles that changed. Admin session with CSRF, or the CLI token.
 *
 * Answers the source list as GET /api/market/source does, plus `results`: per source whether the market answered,
 * and why not. A market that cannot be read keeps what the box has of it; one that has not finished in time is
 * reported as still being read (`ok: false`), and the box reads on in the background.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdminCsrf } from '@/lib/auth/rbac';
import { marketSourceView, refreshMarketForReader } from '@/lib/market/market-store';
import { getConfiguredMarketSources, getRemovedMarketSources } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === 'string' ? body.id.trim() : '';
  try {
    const configured = await getConfiguredMarketSources();
    const wanted = configured.filter((source) => (id ? source.id === id : source.enabled));
    if (id && wanted.length === 0) return NextResponse.json({ error: `Market source "${id}" does not exist` }, { status: 404 });
    const results = await Promise.all(wanted.map(async (source) => {
      try {
        const accepted = await refreshMarketForReader(source);
        return { id: source.id, ok: true as const, sequence: accepted.pointer.sequence, commit: accepted.pointer.commit ?? null };
      } catch (error) {
        return { id: source.id, ok: false as const, error: error instanceof Error ? error.message : String(error) };
      }
    }));
    return NextResponse.json({
      status: 'ok',
      results,
      sources: await Promise.all(configured.map(marketSourceView)),
      removed_sources: await getRemovedMarketSources().catch(() => []),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to refresh the markets' }, { status: 500 });
  }
}
