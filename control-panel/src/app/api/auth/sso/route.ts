/**
 * SSO Initiation Route
 *
 * GET /api/auth/sso - Redirects user to Authentik OAuth2 authorize endpoint
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { buildAuthorizeUrl, generateOAuthState, isSSOConfigured } from '@/lib/auth/authentik';

export async function GET(request: NextRequest) {
  if (!isSSOConfigured()) {
    return NextResponse.json({ error: 'SSO not configured' }, { status: 503 });
  }

  // Use CONTROL_EXTERNAL_URL env var for reliable redirect URI,
  // falling back to request headers if not set
  let redirectUri: string;
  const controlUrl = process.env.CONTROL_EXTERNAL_URL;
  if (controlUrl) {
    redirectUri = `${controlUrl}/api/auth/callback`;
  } else {
    const host = request.headers.get('host') || '';
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    redirectUri = `${proto}://${host}/api/auth/callback`;
  }

  // Generate state for CSRF protection
  const state = generateOAuthState();

  // Store state in a cookie for verification on callback
  const cookieStore = await cookies();
  const isSecure = redirectUri.startsWith('https://');
  cookieStore.set('oauth-state', state, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    maxAge: 300, // 5 minutes
    path: '/',
  });

  const authorizeUrl = buildAuthorizeUrl(redirectUri, state);
  return NextResponse.redirect(authorizeUrl);
}
