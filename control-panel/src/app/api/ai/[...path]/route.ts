import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth/session';
import { allowedPointerManagementPath, pointerManagementFetch } from '@/lib/pointer/client';

async function proxy(request: NextRequest, segments: string[]) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const csrf = request.headers.get('x-csrf-token') ?? '';
    if (!(await verifyCSRFToken(csrf))) {
      return NextResponse.json({ error: 'Invalid CSRF token' }, { status: 403 });
    }
  }
  const path = `/api/${segments.map(encodeURIComponent).join('/')}`;
  if (!allowedPointerManagementPath(path)) {
    return NextResponse.json({ error: 'AI management route is unavailable' }, { status: 404 });
  }
  const url = new URL(request.url);
  const suffix = url.searchParams.size ? `?${url.searchParams.toString()}` : '';
  const contentType = request.headers.get('content-type');
  const body = request.method === 'GET' || request.method === 'HEAD'
    ? undefined
    : await request.arrayBuffer();
  try {
    const upstream = await pointerManagementFetch(session, `${path}${suffix}`, {
      method: request.method,
      headers: contentType ? { 'content-type': contentType } : undefined,
      body,
    });
    return new NextResponse(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json({
      error: 'AI service is unavailable',
      code: 'pointer_unavailable',
    }, { status: 503 });
  }
}

type Context = { params: Promise<{ path: string[] }> };
export async function GET(request: NextRequest, context: Context) { return proxy(request, (await context.params).path); }
export async function POST(request: NextRequest, context: Context) { return proxy(request, (await context.params).path); }
export async function PUT(request: NextRequest, context: Context) { return proxy(request, (await context.params).path); }
export async function PATCH(request: NextRequest, context: Context) { return proxy(request, (await context.params).path); }
export async function DELETE(request: NextRequest, context: Context) { return proxy(request, (await context.params).path); }
