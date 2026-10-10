import { NextRequest, NextResponse } from 'next/server';
import { POINTER_MANAGEMENT_BASE } from '@/lib/pointer/client';
import { allowedPointerAssetPath } from '@/lib/pointer/ui-assets';

export async function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const path = (await context.params).path.join('/');
  if (!allowedPointerAssetPath(path) || new URL(request.url).search) return new NextResponse(null, { status: 404 });
  try {
    const response = await fetch(`${POINTER_MANAGEMENT_BASE}/_pointer/ui/${path}`, {
      redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
    });
    if (!response.ok) return new NextResponse(null, { status: 404 });
    return new NextResponse(response.body, { headers: {
      'content-type': response.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': path === 'manifest.json' ? 'no-store' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    } });
  } catch { return NextResponse.json({ error: 'Pointer interface is unavailable' }, { status: 503 }); }
}
