import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { POINTER_MANAGEMENT_BASE, POINTER_INFERENCE_PORT } from '@/lib/pointer/client';
import { PointerRequestTooLarge, readPointerRequestBody } from '@/lib/pointer/request-body';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session || session.authMethod === 'pam' || session.authMethod === 'cli') return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!await verifyCSRFToken(request.headers.get('x-csrf-token') ?? '')) return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
  let text: string;
  try { text = new TextDecoder().decode(await readPointerRequestBody(request, 1024 * 1024)); }
  catch (error) { return NextResponse.json({ error: error instanceof PointerRequestTooLarge ? 'Test request is too large' : 'Invalid test request' }, { status: error instanceof PointerRequestTooLarge ? 413 : 400 }); }
  let body;
  try { body = JSON.parse(text); } catch { return NextResponse.json({ error: 'Invalid test request' }, { status: 400 }); }
  if (!body || typeof body.key !== 'string' || !/^ptr_[A-Za-z0-9_-]{20,100}$/.test(body.key) || !['models', 'chat'].includes(body.operation)
    || body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(body.sessionId))) return NextResponse.json({ error: 'A Pointer key and valid test operation are required' }, { status: 400 });
  const destination = new URL(POINTER_MANAGEMENT_BASE); destination.port = String(POINTER_INFERENCE_PORT);
  destination.pathname = body.operation === 'models' ? '/v1/models' : '/v1/chat/completions';
  try {
    const response = await fetch(destination, {
      method: body.operation === 'models' ? 'GET' : 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${body.key}`, ...(body.sessionId ? { 'x-opencode-session': body.sessionId } : {}) },
      body: body.operation === 'models' ? undefined : JSON.stringify(body.request),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(300_000)]),
    });
    return new NextResponse(response.body, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store', 'x-accel-buffering': 'no' } });
  } catch { return NextResponse.json({ error: 'Pointer inference is unavailable' }, { status: 503 }); }
}
