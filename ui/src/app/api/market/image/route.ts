/**
 * GET /api/market/image?url=<encoded-url>
 *
 * Proxies external images so the app drawer can display icons for
 * external/Market-installed apps.  Icon URLs are stored in the DB as
 * "/api/market/image?url=..." (relative to whichever host serves
 * the page).  The CP already has this endpoint; the UI mirrors it
 * so icons render on the UI domain too.
 *
 * Only allows URLs from trusted domains.
 */

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_DOMAINS = [
  'github.com',
  'raw.githubusercontent.com',
  'avatars.githubusercontent.com',
  'cdn.jsdelivr.net',
  'immich.app',
  'usememos.com',
  'i.ibb.co',
  'jellyfin.org',
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function isTrustedImageURL(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash
      && ALLOWED_DOMAINS.some((domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain));
  } catch {
    return false;
  }
}

async function fetchTrustedImage(raw: string): Promise<Response> {
  let current = raw;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isTrustedImageURL(current)) throw new Error('Image URL or redirect is not trusted');
    const response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    if (redirects === 5) throw new Error('Image download exceeded five redirects');
    const location = response.headers.get('location');
    if (!location) throw new Error('Image redirect omitted Location');
    current = new URL(location, current).toString();
  }
  throw new Error('Image download did not terminate');
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');

  if (!imageUrl) {
    return NextResponse.json({ error: 'url parameter required' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  if (!isTrustedImageURL(parsed.toString())) {
    return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
  }

  try {
    const res = await fetchTrustedImage(imageUrl);
    if (!res.ok) {
      return NextResponse.json({ error: `Failed to fetch: ${res.status}` }, { status: 502 });
    }
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    const buffer = await res.arrayBuffer();

    return new NextResponse(Buffer.from(buffer), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    return NextResponse.json({ error: `Proxy error: ${err}` }, { status: 502 });
  }
}
