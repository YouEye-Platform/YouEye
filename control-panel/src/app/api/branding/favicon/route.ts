/**
 * Favicon Proxy — CP fetches the rendered favicon from UI via bridge.
 *
 * GET /api/branding/favicon?size=32
 *
 * Caches the response for 1 hour.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';

const TOKEN_FILE_PATH = '/etc/youeye/ui-bridge-token';
const UI_BASE = `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

let cachedToken: string | null = null;

function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync(TOKEN_FILE_PATH, 'utf-8').trim();
    return cachedToken;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  const size = request.nextUrl.searchParams.get('size') || '32';
  const maskable = request.nextUrl.searchParams.get('maskable');
  const token = getBridgeToken();

  if (!token) {
    return new NextResponse(null, { status: 503 });
  }

  try {
    const params = new URLSearchParams({ size });
    if (maskable) params.set('maskable', maskable);
    const res = await fetch(
      `${UI_BASE}/api/v1/branding/icon?${params}`,
      { signal: AbortSignal.timeout(5000) }
    );

    if (!res.ok) {
      return new NextResponse(null, { status: res.status });
    }

    const buf = Buffer.from(await res.arrayBuffer());
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch {
    return new NextResponse(null, { status: 502 });
  }
}
