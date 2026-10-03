import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { getClient, revokeAccessToken, revokeRefreshToken } from '@/lib/identity/store';
import { inspectAccessToken } from '@/lib/identity/tokens';

function credentials(request: NextRequest, form: FormData): { clientId: string; clientSecret: string } | null {
  const header = request.headers.get('authorization');
  if (header) {
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
    if (!match) return null;
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
  }
  return { clientId: String(form.get('client_id') || ''), clientSecret: String(form.get('client_secret') || '') };
}

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const auth = credentials(request, form);
  const client = auth ? await getClient(auth.clientId) : null;
  const expected = Buffer.from(client?.client_secret || '', 'utf8');
  const supplied = Buffer.from(auth?.clientSecret || '', 'utf8');
  if (!client || (client.client_secret ? expected.length !== supplied.length || !timingSafeEqual(expected, supplied) : supplied.length !== 0)) {
    return NextResponse.json({ error: 'invalid_client' }, { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="youeye-id"' } });
  }

  const token = String(form.get('token') || '');
  if (token) {
    await revokeRefreshToken(token, client.client_id);
    const access = await inspectAccessToken(token, client.client_id);
    if (access) await revokeAccessToken(access.jti, access.exp);
  }
  return new NextResponse(null, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
