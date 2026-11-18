/**
 * GET /api/market/image?source=<source id>&file=<h/files/<sha256>.<ext>>
 *
 * A picture (icon or screenshot) of a market this box reads. It needs no sign-in, so it serves only what an owner
 * already chose to read: a picture path that the accepted index or a stored app bundle of an enabled, accepted
 * market names. Any other request (another path, an unknown or disabled source, a custom market that is not
 * accepted, a URL) is answered 404 and causes no outbound request.
 *
 * A named picture is read from the box's copy of the market; the first time, it is fetched from the market's own
 * address (5 MiB limit, checked against the SHA-256 in its path, one fetch shared by simultaneous requests) and
 * kept. The path names the content, so the answer never changes and may be cached for good.
 *
 * The box fetches at most four pictures from markets at a time (three from one market), so requests for many
 * pictures it does not hold yet cannot fill its memory with 5 MiB bodies. A request beyond that waits its turn, 20
 * seconds at most, and is then answered 503 with `Retry-After`; the picture is fetched when it is asked for again.
 */

import { fileHashOf } from '@/lib/market/market-format';
import { readMarketPicture } from '@/lib/market/market-store';
import { getConfiguredMarketSources, marketSourceRefusal } from '@/lib/market/source';

export const dynamic = 'force-dynamic';

// Every answer is inert in the box's origin: an SVG opened directly cannot run script, and the browser never
// sniffs a different type. (The proxy sets the same policy for this path; this covers requests that bypass it.)
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
} as const;

const refused = (status: 404 | 502 | 503, headers: Record<string, string> = {}) =>
  new Response(null, { status, headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store', ...headers } });

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get('source') ?? '';
  const file = searchParams.get('file') ?? '';
  if (!sourceId || !fileHashOf(file)) return refused(404);

  let picture: Awaited<ReturnType<typeof readMarketPicture>>;
  try {
    const source = (await getConfiguredMarketSources()).find((candidate) => candidate.id === sourceId);
    // Only a source that apps may be installed from: enabled, and accepted when it is a custom market.
    if (!source || marketSourceRefusal(source)) return refused(404);
    picture = await readMarketPicture(source, file);
  } catch (error) {
    // By name: the store module is bundled more than once.
    if (error instanceof Error && error.name === 'MarketBusyError') {
      const seconds = Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds);
      return refused(503, { 'Retry-After': String(Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 5) });
    }
    console.warn(`[market/image] ${sourceId}/${file} is unavailable:`, error instanceof Error ? error.message : error);
    return refused(502);
  }
  if (!picture) return refused(404);

  return new Response(new Uint8Array(picture.bytes), {
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': picture.contentType,
      'Content-Length': String(picture.bytes.byteLength),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
