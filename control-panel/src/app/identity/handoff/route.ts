import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { setIdentityCookie } from '@/lib/identity/http';
import { isTrustedHandoffBrowserOrigin } from '@/lib/identity/handoff-origin';
import { consumeSetupHandoff } from '@/lib/identity/store';
import { createIdentityToken } from '@/lib/identity/tokens';

function requestPublicOrigin(request: NextRequest, expected: string): string | null {
  const expectedOrigin = new URL(expected).origin;
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedProto = request.headers.get('x-forwarded-proto');
  let candidate = request.nextUrl.origin;

  if (forwardedHost || forwardedProto) {
    if (!forwardedHost || !forwardedProto || forwardedHost.includes(',') || forwardedProto.includes(',')) return null;
    if (forwardedProto !== 'https' && forwardedProto !== 'http') return null;
    try {
      candidate = new URL(`${forwardedProto}://${forwardedHost}`).origin;
    } catch {
      return null;
    }
  }
  if (candidate !== expectedOrigin) return null;
  const browserOrigin = request.headers.get('origin');
  if (!isTrustedHandoffBrowserOrigin(browserOrigin, expectedOrigin)) return null;
  return expectedOrigin;
}

export async function POST(request: NextRequest) {
  const config = await getIdentityConfig();
  const requestOrigin = requestPublicOrigin(request, config.externalUrl);
  if (!requestOrigin) {
    return new NextResponse('Invalid handoff target.', { status: 400 });
  }

  const form = await request.formData();
  const code = String(form.get('code') || '');
  if (!code || code.length > 128) return new NextResponse('Invalid or expired handoff.', { status: 400 });
  const user = await consumeSetupHandoff(code, requestOrigin);
  if (!user) return new NextResponse('This handoff has expired or was already used. Return to the appliance IP and try again.', { status: 400 });

  const token = await createIdentityToken(user);
  const response = NextResponse.redirect(`https://${config.domain}/`, { status: 303 });
  setIdentityCookie(response, token, config.cookieDomain);
  return response;
}
