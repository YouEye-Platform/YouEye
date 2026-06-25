import { NextRequest, NextResponse } from 'next/server';
import { userinfo } from '@/lib/identity/http';
import { verifyBearerToken } from '@/lib/identity/tokens';

async function tokenFromRequest(request: NextRequest): Promise<string> {
  const auth = request.headers.get('authorization') || '';
  const bearerToken = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearerToken) return bearerToken;

  const queryToken = request.nextUrl.searchParams.get('access_token');
  if (queryToken) return queryToken;

  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/x-www-form-urlencoded') || contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      return String(form.get('access_token') || '');
    }
  }

  return '';
}

async function handleUserinfo(request: NextRequest) {
  const token = await tokenFromRequest(request);
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 401 });
  const user = await verifyBearerToken(token);
  if (!user) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  return NextResponse.json(userinfo(user));
}

export async function GET(request: NextRequest) {
  return handleUserinfo(request);
}

export async function POST(request: NextRequest) {
  return handleUserinfo(request);
}
