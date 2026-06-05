import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE, verifyIdentityToken } from './tokens';
import type { IdentityUser } from './store';

export async function getIdentitySession(request: NextRequest): Promise<IdentityUser | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifyIdentityToken(token);
}

export function userinfo(user: IdentityUser) {
  return {
    sub: user.id,
    preferred_username: user.username,
    name: user.name || user.username,
    email: user.email,
    groups: user.groups,
    is_admin: user.is_admin,
  };
}

export function setIdentityCookie(response: NextResponse, token: string, cookieDomain: string): void {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.SECURE_COOKIES !== 'false',
    sameSite: 'lax',
    maxAge: 86400,
    path: '/',
    domain: cookieDomain,
  });
}

