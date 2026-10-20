import { readCoreComponentJSON } from '../../../../../../shared/core-component-http';
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { ensureIdentitySchema, identityCommand } from '@/lib/identity/store';
import { coreSchemaComponent, coreSchemaStatus } from '@/lib/updates/core-schema';

export const dynamic = 'force-dynamic';
async function nativeAccess() {
  const session = await getSession();
  return session?.isAdmin && session.authMethod === 'cli';
}
export async function GET(request: NextRequest) {
  if (!await nativeAccess()) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  try {
    const status = await coreSchemaStatus('cp');
    if (status.managed && status.state === 'pending') {
      // The CP HTTP listener can be ready before Incus binds its HTTPS API
      // after boot. Probe the actual CP -> Incus -> PostgreSQL path before
      // allowing native code to submit its one-shot schema mutation. This
      // read-only check creates no schema receipt and can safely be retried.
      await identityCommand('BEGIN READ ONLY; SELECT 1; COMMIT');
    }
    if (request.nextUrl.searchParams.get('health') === '1') {
      if (!status.managed || status.state !== 'completed') throw new Error('Completed core required');
      await identityCommand('BEGIN READ ONLY; SELECT id FROM identity_users LIMIT 0; SELECT client_id FROM identity_clients LIMIT 0; COMMIT');
      return NextResponse.json({ ...status, databaseReady: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json(status);
  }
  catch { return NextResponse.json({ error: 'Core component state unavailable' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  if (!await nativeAccess()) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) return NextResponse.json({ error: 'Bounded exact component request required' }, { status: 400 });
  try {
    const selected = await coreSchemaComponent('cp');
    const body = await readCoreComponentJSON(request.body, 4096) as { requestId?: unknown; manifestSHA256?: unknown; artifactSHA256?: unknown } | null;
    if (!selected || body?.requestId !== selected.requestId || body?.manifestSHA256 !== selected.manifestSHA256 || body?.artifactSHA256 !== selected.artifactSHA256) {
      return NextResponse.json({ error: 'Core component request differs from native selection' }, { status: 409 });
    }
    await ensureIdentitySchema();
    return NextResponse.json(await coreSchemaStatus('cp'));
  } catch { return NextResponse.json({ error: 'Core schema requires native reconciliation' }, { status: 409 }); }
}
