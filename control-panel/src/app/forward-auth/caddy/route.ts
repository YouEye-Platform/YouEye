import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getIdentitySession, userinfo } from '@/lib/identity/http';

function originalUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') || 'https';
  const host = request.headers.get('x-forwarded-host') || request.headers.get('host') || '';
  const uri = request.headers.get('x-forwarded-uri') || '/';
  return `${proto}://${host}${uri}`;
}

export async function GET(request: NextRequest) {
  const config = await getIdentityConfig();
  const user = await getIdentitySession(request);
  if (!user) {
    const login = new URL('/identity/login', config.externalUrl);
    login.searchParams.set('return_to', originalUrl(request));
    return NextResponse.redirect(login);
  }

  const info = userinfo(user);
  const response = new NextResponse(null, { status: 204 });
  response.headers.set('X-YouEye-Username', info.preferred_username);
  response.headers.set('X-YouEye-Groups', info.groups.join(','));
  response.headers.set('X-YouEye-Email', info.email);
  response.headers.set('X-YouEye-Name', info.name);
  response.headers.set('X-YouEye-Uid', info.sub);
  response.headers.set('X-Authentik-Username', info.preferred_username);
  response.headers.set('X-Authentik-Groups', info.groups.join(','));
  response.headers.set('X-Authentik-Email', info.email);
  response.headers.set('X-Authentik-Name', info.name);
  response.headers.set('X-Authentik-Uid', info.sub);
  return response;
}

