/**
 * SSO Initiation Route
 *
 * GET /api/auth/sso - redirects the user to the OAuth2 authorize endpoint
 *
 * Accepts optional ?redirect= param to return the user to a specific page
 * after authentication (used by embed auto-login flow).
 */

import { NextRequest, NextResponse } from 'next/server';
import { excessOAuthTransactions, oauthTransactionName, oauthTransactionValue, safeOAuthReturn } from '../../../../../../shared/oauth-transaction';
import { buildAuthorizeUrl, generateOAuthState, isSSOConfigured } from '@/lib/auth/oauth';
import { isSettingsPath, getSettingsPublicUrl } from '@/lib/settings-public-path';

export async function GET(request: NextRequest) {
  if (!isSSOConfigured()) {
    return NextResponse.json({ error: 'SSO not configured' }, { status: 503 });
  }

  const settingsFlow = isSettingsPath(request.nextUrl.pathname);

  // Use CONTROL_EXTERNAL_URL/CONTROL_PUBLIC_URL env vars for reliable redirect URI,
  // falling back to request headers if not set.
  let redirectUri: string;
  const controlUrl = settingsFlow ? getSettingsPublicUrl(request) : process.env.CONTROL_EXTERNAL_URL;
  if (controlUrl) {
    redirectUri = `${controlUrl}/api/auth/callback`;
  } else {
    const host = request.headers.get('host') || '';
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    redirectUri = `${proto}://${host}/api/auth/callback`;
  }

  // Generate state for CSRF protection
  const state = generateOAuthState();

  const returnTo = safeOAuthReturn(request.nextUrl.searchParams.get('redirect'), settingsFlow ? '/settings' : '/');
  const response = NextResponse.redirect(buildAuthorizeUrl(redirectUri, state));
  for (const name of excessOAuthTransactions('cp', request.cookies.getAll().map(cookie => cookie.name))) response.cookies.delete(name);
  response.cookies.set(oauthTransactionName('cp', state)!, oauthTransactionValue(state, returnTo), {
    httpOnly: true,
    secure: redirectUri.startsWith('https://'),
    sameSite: 'lax',
    maxAge: 300,
    path: '/',
  });
  return response;
}
