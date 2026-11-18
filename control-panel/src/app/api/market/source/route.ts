/**
 * Market sources.
 *
 * GET   /api/market/source  — every source (official first by priority) and `removed_sources` (git sources this box
 *                             had before markets were read by address). Each source carries `accepted_at` (custom
 *                             ones), `address` (where its market was read from), `market` (the market's own words
 *                             and state: name, publisher, commit, sequence date, apps), `accepted_market_at`,
 *                             `refreshed_at`, `checked_at` and `refresh_error`.
 * POST  /api/market/source  — add a custom market by address: { url, name?, id?, acceptRisk: true }. The owner's
 *                             consent is the `acceptRisk` tick, so the new market is accepted at once. The market is
 *                             read first; an address that is not a market is refused and nothing is added. An official
 *                             lane (`https://market.youeye.me/` or `…/dev/`) is refused before anything is fetched: the
 *                             box already follows the official Market. The answer waits for the first copy of the
 *                             market for 20 seconds at most; a larger market appears when the box has read it.
 * PATCH /api/market/source  — { active_sources: [...] }: enable, disable, rename, reorder or remove existing sources.
 *                             It cannot add one or accept one; a changed address drops the acceptance, and an
 *                             official lane is refused as an address.
 *                             { dismiss_removed_sources: true } clears the note about removed sources.
 *
 * The list never fails for one source: a source whose copy of its market cannot be shown is listed without a market
 * and with the reason in `refresh_error`, so it can still be turned off or removed.
 *
 * Accepting an existing source: POST /api/market/source/accept. Asking the markets again now: POST
 * /api/market/source/refresh. Admin session with CSRF, or the CLI token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireAdminCsrf } from '@/lib/auth/rbac';
import { clearCatalogCache } from '@/lib/market/catalog';
import { marketSourceView, previewMarket, refreshMarketForReader, removeMarketStoresExcept } from '@/lib/market/market-store';
import {
  OFFICIAL_MARKET_AS_CUSTOM, addMarketSource, checkedMarketAddress, dismissRemovedMarketSources, getConfiguredMarketSources,
  getRemovedMarketSources, isOfficialMarketLane, updateMarketSourceList, type MarketSource,
} from '@/lib/market/source';

export const dynamic = 'force-dynamic';

/** The list as every answer of this route carries it. `marketSourceView` never throws, so one source cannot break it. */
const listing = async (sources: MarketSource[]) => ({
  sources: await Promise.all(sources.map(marketSourceView)),
  removed_sources: await getRemovedMarketSources().catch(() => []),
});

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
  if (!body || typeof body !== 'object' || typeof body.url !== 'string' || !body.url.trim()) {
    return NextResponse.json({ error: 'url is required (the address of the market)' }, { status: 400 });
  }
  if (body.acceptRisk !== true) {
    return NextResponse.json({
      error: 'Apps from this source are not checked by YouEye. They run their own setup steps on your box. '
        + 'Add only sources you trust, and confirm it (acceptRisk: true).',
      code: 'source-not-accepted',
    }, { status: 400 });
  }
  for (const field of ['name', 'id'] as const) {
    if (body[field] !== undefined && typeof body[field] !== 'string') {
      return NextResponse.json({ error: `${field} must be text` }, { status: 400 });
    }
  }
  try {
    const address = checkedMarketAddress(body.url);
    // The official Market is always a source; either of its lanes as a custom market would list every app twice.
    if (isOfficialMarketLane(address)) return NextResponse.json({ error: OFFICIAL_MARKET_AS_CUSTOM }, { status: 400 });
    // Read the market before anything is written: a typing mistake or a page that is not a market adds nothing.
    const preview = await previewMarket(address);
    // Without a name from the owner the source is called by its host. What the market calls itself is in
    // `market.name`: its own words, shown as such, never as the box's name for it.
    const source = await addMarketSource({ url: preview.address, name: body.name, id: body.id });
    // The first copy of the market, so its apps are listed at once. A failure here leaves the source with its error;
    // a market that takes longer than a reader waits is read on in the background.
    await refreshMarketForReader(source).catch(() => undefined);
    console.log(`[Market] Source ${source.id} (${source.url}) added and accepted by ${auth.session.username}`);
    return NextResponse.json({ status: 'ok', source: await marketSourceView(source), ...await listing(await getConfiguredMarketSources()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to add Market source' }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  try {
    const body = await request.json();
    if (body?.dismiss_removed_sources === true) {
      await dismissRemovedMarketSources();
      return NextResponse.json({ status: 'ok', ...await listing(await getConfiguredMarketSources()) });
    }
    if (Array.isArray(body?.active_sources)) {
      const sources = await updateMarketSourceList(body.active_sources);
      // A removed source's copy of its market goes with it.
      await removeMarketStoresExcept(sources.map((source) => source.id)).catch(() => undefined);
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
