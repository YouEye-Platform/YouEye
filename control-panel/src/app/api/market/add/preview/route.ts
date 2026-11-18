/**
 * POST /api/market/add/preview?market=<address>  or  ?app=<manifest URL>   (no body)
 *
 * What an "Add to YouEye" link would add, for the page that asks the owner (`/market/add`). Admin session with the
 * CSRF token, or the CLI token (which needs no CSRF token): it makes the box fetch an address the link chose, so a
 * page an admin merely visits must not be able to start it (a GET, or a POST without the token). At most
 * `MAX_RUNNING_PREVIEWS` run at once in this process; more answer 429. It reads the market (its market.json and
 * index, both checked against their hashes) or the app (its manifest and setup files) with the Market's fetchers
 * (HTTPS, public addresses only, no redirects, size limits) and writes NOTHING: no source, no store, no Added app.
 * Adding is the existing guarded calls (`POST /api/market/source`, `POST /api/market/validate-url`).
 *
 * Answers (what a market or app says about itself is its own words, plain text):
 * - market: { kind: 'market', address, name, publisher, homepage? (only an https address), apps (its container apps, the
 *   count `youeye market list` shows), apps_with_setup, native? (YouEye's own apps it names; only for the box's own
 *   official Market), already_added: <source id> | null }
 * - app: { kind: 'app', url, host, id, name, version, images: [...], setups: [file names], already_added: <source id> | null }
 * - a bad link: 400 { error }; a market or app that cannot be read: 502 { error, details? }.
 */
import { NextResponse } from 'next/server';
import { requireAdminCsrf } from '@/lib/auth/rbac';
import { getDirectMarketApp, directSourceIdFor } from '@/lib/market/direct-apps';
import { previewMarket } from '@/lib/market/market-store';
import { getConfiguredMarketSources, isOfficialMarketAddress, OFFICIAL_MARKET_SOURCE_ID } from '@/lib/market/source';
import { fetchUrlApp } from '@/lib/market/url-app';
import { addLinkParameter, type AddLinkParameter } from '../link-parameter';

export const dynamic = 'force-dynamic';

/** A market's homepage, only when it is a plain https address. */
function httpsHomepage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const failure = (error: unknown) => {
  const details = (error as { details?: unknown })?.details;
  return NextResponse.json({
    error: error instanceof Error ? error.message : 'It could not be read',
    ...(Array.isArray(details) && details.length ? { details: details.filter((detail) => typeof detail === 'string').slice(0, 20) } : {}),
  }, { status: 502 });
};

/** Previews that may fetch at the same time in this process. */
const MAX_RUNNING_PREVIEWS = 2;
let runningPreviews = 0;

export async function POST(request: Request) {
  const auth = await requireAdminCsrf(request);
  if (auth.error) return auth.error;

  const parameter = addLinkParameter(new URL(request.url).searchParams);
  if ('error' in parameter) return NextResponse.json({ error: parameter.error }, { status: 400 });

  if (runningPreviews >= MAX_RUNNING_PREVIEWS) {
    return NextResponse.json({ error: 'Other previews are still being read. Try again in a moment.' }, { status: 429 });
  }
  runningPreviews++;
  try {
    return await previewOf(parameter);
  } finally {
    runningPreviews--;
  }
}

async function previewOf(parameter: AddLinkParameter): Promise<Response> {
  if (parameter.kind === 'market') {
    let summary: Awaited<ReturnType<typeof previewMarket>>;
    try { summary = await previewMarket(parameter.address); }
    catch (error) { return failure(error); }
    // previewMarket reads an official lane only when it is the box's own (another lane is refused there).
    const official = isOfficialMarketAddress(summary.address);
    const existing = official
      ? OFFICIAL_MARKET_SOURCE_ID
      : (await getConfiguredMarketSources()).find((source) => source.url === summary.address)?.id ?? null;
    const homepage = httpsHomepage(summary.homepage);
    return NextResponse.json({
      kind: 'market',
      address: summary.address,
      name: summary.name,
      publisher: summary.publisher,
      ...(homepage ? { homepage } : {}),
      apps: summary.apps,
      apps_with_setup: summary.apps_with_setup,
      ...(official ? { native: summary.native } : {}),
      already_added: existing,
    });
  }

  let manifest: Awaited<ReturnType<typeof fetchUrlApp>>;
  try { manifest = await fetchUrlApp(parameter.url); }
  catch (error) { return failure(error); }
  const sourceId = directSourceIdFor(parameter.url);
  const existing = await getDirectMarketApp(sourceId, manifest.metadata.id);
  return NextResponse.json({
    kind: 'app',
    url: parameter.url,
    host: new URL(parameter.url).host,
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    version: manifest.version ?? null,
    images: manifest.containers.filter((container) => container.type === 'oci').map((container) => container.image),
    setups: manifest.setups.map((setup) => setup.name),
    already_added: existing ? sourceId : null,
  });
}
