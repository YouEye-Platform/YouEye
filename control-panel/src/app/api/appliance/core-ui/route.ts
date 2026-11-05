import { NextRequest, NextResponse } from 'next/server';
import { constants } from 'node:fs';
import { isIP } from 'node:net';
import { open } from 'node:fs/promises';
import { getSession } from '@/lib/auth';
import { getSystemStaticIP } from '@/lib/incus/static-ips';
import { incusRequest } from '@/lib/incus/server';
import { selectedCoreRole } from '@/lib/releases/core-release';
import { readCoreComponentJSON, reconcileCoreUI } from '../../../../../../shared/core-component-http';

export const dynamic = 'force-dynamic';
async function nativeAccess() {
  const session = await getSession();
  return session?.isAdmin && session.authMethod === 'cli';
}
async function reconcile(requested?: unknown, health = false) {
  const { member } = selectedCoreRole('ui');
  const ip = await getSystemStaticIP('youeye-ui');
  if (!ip || isIP(ip) !== 4 || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) throw new Error('Private UI address required');
  const state = await incusRequest<{ status: string; network?: Record<string, { addresses?: { family: string; scope: string; address: string }[] }> }>('GET', '/1.0/instances/youeye-ui/state');
  if (state.metadata?.status !== 'Running' || !Object.entries(state.metadata.network ?? {}).some(([name, net]) => name !== 'lo' && net.addresses?.some(a => a.family === 'inet' && a.scope === 'global' && a.address === ip))) throw new Error('Exact UI network identity unavailable');
  const file = await open('/etc/youeye/ui-bridge-token', constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let token: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 128 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) throw new Error('Protected UI bridge credential required');
    const bytes = Buffer.alloc(129), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== stat.size) throw new Error('UI bridge credential changed');
    token = bytes.subarray(0, result.bytesRead).toString('utf8').trim();
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid UI bridge credential');
  } finally { await file.close(); }
  const result = await reconcileCoreUI(member.artifact.sha256, async (method, body) => {
    const encoded = body ? JSON.stringify(body) : undefined;
    const response = await fetch(`http://${ip}:3000/api/ui-bridge/core-component${health ? '?health=1' : ''}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000), cache: 'no-store',
      headers: { 'X-UI-Bridge-Token': token, ...(encoded ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(encoded)) } : {}) },
      body: encoded,
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('UI component request requires reconciliation'); }
    const value = await readCoreComponentJSON(response.body, 16384);
    if (health && (value as { databaseReady?: unknown } | null)?.databaseReady !== true) throw new Error('UI database health unavailable');
    return value;
  }, requested);
  return health ? { ...result, databaseReady: true } : result;
}
export async function GET(request: NextRequest) {
  if (!await nativeAccess()) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  try { return NextResponse.json(await reconcile(undefined, request.nextUrl.searchParams.get('health') === '1')); }
  catch { return NextResponse.json({ error: 'UI core observation unavailable' }, { status: 503 }); }
}
export async function POST(request: NextRequest) {
  if (!await nativeAccess()) return NextResponse.json({ error: 'Native core authority required' }, { status: 403 });
  const length = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(length) || length < 1 || length > 4096) return NextResponse.json({ error: 'Bounded exact component request required' }, { status: 400 });
  try { return NextResponse.json(await reconcile(await readCoreComponentJSON(request.body, 4096))); }
  catch { return NextResponse.json({ error: 'UI core schema requires reconciliation' }, { status: 409 }); }
}
