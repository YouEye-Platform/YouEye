import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifyIdentityToken, identityTokenClaims, IDENTITY_SESSION_MAX_AGE_SECONDS } from './tokens';
import type { IdentityUser } from './store';

export async function getIdentitySession(request: NextRequest): Promise<IdentityUser | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyIdentityToken(token);
}

export async function getIdentitySessionId(request: NextRequest): Promise<string | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return (await identityTokenClaims(token))?.sid || null;
}

export function userinfo(user: IdentityUser) {
  return {
    sub: user.id,
    preferred_username: user.username,
	name: user.name || user.username,
	given_name: user.first_name,
	family_name: user.last_name,
    email: user.email,
    email_verified: true,
    groups: user.groups,
    is_admin: user.is_admin,
  };
}

export function setIdentityCookie(response: NextResponse, token: string, cookieDomain: string): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.SECURE_COOKIES !== 'false',
    sameSite: 'lax',
    maxAge: IDENTITY_SESSION_MAX_AGE_SECONDS,
    path: '/',
    domain: cookieDomain,
  });
}
