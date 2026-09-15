/**
 * POST /api/market/update — compatibility alias for the youeye CLI.
 *
 * `youeye app update <name>` (spines ≤0.5.13) POSTs {appId} here and streams
 * SSE. The canonical route is POST /api/apps/[name]/update — newer CLIs call
 * it directly; this alias unwraps the body and delegates.
 */

import { type NextRequest } from 'next/server';
import { POST as updateApp } from '../../apps/[name]/update/route';

export async function POST(req: NextRequest) {
  let appId = '';
  let body: { appId?: string; confirm_switch?: boolean } | null = null;
  try {
    body = await req.json();
    if (body && typeof body.appId === 'string') appId = body.appId;
  } catch {
    // fall through to the 400 below
  }
  if (!appId) {
    return new Response(JSON.stringify({ error: 'appId required' }), { status: 400 });
  }
  const forwarded = new Request(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(body ?? {}),
  });
  return updateApp(forwarded as unknown as NextRequest, { params: Promise.resolve({ name: appId }) });
}
