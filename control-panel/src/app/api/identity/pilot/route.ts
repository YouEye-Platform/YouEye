import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth/session';
import { ensureClient, ensureUser } from '@/lib/identity/store';

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  }

  const body = await request.json();
  const required = ['username', 'password', 'clientId', 'clientSecret', 'redirectUri'];
  for (const key of required) {
    if (!body[key] || typeof body[key] !== 'string') {
      return NextResponse.json({ error: `Missing required field: ${key}` }, { status: 400 });
    }
  }

  const user = await ensureUser({
    username: body.username,
    password: body.password,
    name: body.name || body.username,
    email: body.email || '',
    groups: Array.isArray(body.groups) ? body.groups : ['youeye-users'],
    isAdmin: body.isAdmin === true,
  });

  const client = await ensureClient({
    clientId: body.clientId,
    clientSecret: body.clientSecret,
    name: body.clientName || body.clientId,
    redirectUris: [body.redirectUri],
    scopes: ['openid', 'profile', 'email', 'groups'],
  });

  return NextResponse.json({
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      groups: user.groups,
      isAdmin: user.is_admin,
    },
    client: {
      clientId: client.client_id,
      redirectUris: client.redirect_uris,
      scopes: client.scopes,
    },
  });
}

