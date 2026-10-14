import { readCoreComponentJSON } from '../../../../../../shared/core-component-http';
import { sql } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getBridgeToken } from '@/lib/admin/bridge-client';
import { db, ensureSchema } from '@/db';
import { coreSchemaComponent, coreSchemaStatus } from '@/lib/core-schema';

export const dynamic = 'force-dynamic';
function nativeAccess(request: NextRequest) {
  const expected = getBridgeToken();
  const provided = request.headers.get('X-UI-Bridge-Token');
  if (!expected || !provided) return false;
  const a = Buffer.from(expected), b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function GET(request: NextRequest) {
  if (!nativeAccess(request)) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  try {
    const status = await coreSchemaStatus('ui');
    if (request.nextUrl.searchParams.get('health') === '1') {
      if (!status.managed || status.state !== 'completed') throw new Error('Completed core required');
      await db.execute(sql`SELECT id, identity_id FROM users LIMIT 0`);
      await db.execute(sql`SELECT app_id, installation_id FROM admission_projections LIMIT 0`);
      return NextResponse.json({ ...status, databaseReady: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(status);
  }
  catch { return NextResponse.json({ error: 'Core component state unavailable' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  if (!nativeAccess(request)) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) return NextResponse.json({ error: 'Bounded exact component request required' }, { status: 400 });
  try {
    const selected = await coreSchemaComponent('ui');
    const body = await readCoreComponentJSON(request.body, 4096) as { requestId?: unknown; manifestSHA256?: unknown; artifactSHA256?: unknown } | null;
    if (!selected || body?.requestId !== selected.requestId || body?.manifestSHA256 !== selected.manifestSHA256 || body?.artifactSHA256 !== selected.artifactSHA256) {
      return NextResponse.json({ error: 'Core component request differs from native selection' }, { status: 409 });
    }
    await ensureSchema();
    return NextResponse.json(await coreSchemaStatus('ui'));
  } catch { return NextResponse.json({ error: 'Core schema requires native reconciliation' }, { status: 409 }); }
}
