/**
 * GET /api/market/image?url=<encoded-url>
 *
 * Proxies external images so the app drawer can display icons for
 * external/marketplace apps.  Icon URLs are stored in the DB as
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

  if (!ALLOWED_DOMAINS.some((d) => parsed.hostname === d || parsed.hostname.endsWith('.' + d))) {
    return NextResponse.json({ error: 'Domain not allowed' }, { status: 403 });
  }

  try {
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(10_000) });
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
