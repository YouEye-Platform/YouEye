import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { SpineAPIError, spineClient, type CoreUpdateAction, type CoreUpdateRequest } from '@/lib/spine/client';
import { readCoreComponentJSON } from '../../../../../../../shared/core-component-http';
export const dynamic = 'force-dynamic';
export async function GET(_request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if ((await params).action !== 'check') return NextResponse.json({ error: 'Unknown System query' }, { status: 404 });
  try { return NextResponse.json(await spineClient.checkCoreUpdate(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch { return NextResponse.json({ error: 'A complete signed System release could not be checked.' }, { status: 503 }); }
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  if (!(await getSession())?.isAdmin) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') ?? '')) return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  const { action } = await params;
  if (!['stage', 'activate', 'resume', 'recover', 'cancel'].includes(action)) return NextResponse.json({ error: 'Unknown System action' }, { status: 404 });
  let body: CoreUpdateRequest;
  try {
    const value = await readCoreComponentJSON(request.body, 4096) as Record<string, unknown> | null;
    if (!value || Object.keys(value).sort().join(',') !== 'command_id,manifest_sha256,request_id'
      || typeof value.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.request_id)
      || typeof value.command_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.command_id)
      || typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) throw new Error('Invalid exact request');
    body = value as unknown as CoreUpdateRequest;
  } catch { return NextResponse.json({ error: 'Exact update, delivery and release identities required' }, { status: 400 }); }
  try { return NextResponse.json(await spineClient.submitCoreUpdate(action as CoreUpdateAction, body)); }
  catch (error) {
    return NextResponse.json({ error: 'The action needs reconciliation. Keep the same update and delivery IDs.' }, { status: error instanceof SpineAPIError ? error.statusCode : 503 });
  }
}
