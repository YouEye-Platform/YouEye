import { NextRequest, NextResponse } from 'next/server';
import { userinfo } from '@/lib/identity/http';
import { verifyBearerToken } from '@/lib/identity/tokens';

export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return NextResponse.json({ error: 'missing_token' }, { status: 401 });
  const user = await verifyBearerToken(token);
  if (!user) return NextResponse.json({ error: 'invalid_token' }, { status: 401 });
  return NextResponse.json(userinfo(user));
}

