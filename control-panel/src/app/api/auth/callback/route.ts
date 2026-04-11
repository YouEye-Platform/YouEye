/**
 * OAuth2 Callback Route
 *
 * GET /api/auth/callback?code=...&state=... - Exchanges code for token, creates session
 */

import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import {
  exchangeCodeForToken,
  fetchUserInfo,
  isSSOConfigured,
} from '@/lib/auth/authentik';
import {
  createSession,
  setSessionCookies,
  generateCSRFToken,
} from '@/lib/auth/session';

const ADMIN_GROUP = 'authentik Admins';

export async function GET(request: NextRequest) {
  if (!isSSOConfigured()) {
    return NextResponse.json({ error: 'SSO not configured' }, { status: 503 });
  }

  // Determine the external base URL for all redirects.
  // Inside the container, request.url is http://0.0.0.0:3000/... which is wrong.
  // Use CONTROL_EXTERNAL_URL or reconstruct from forwarded headers.
  const controlUrl = process.env.CONTROL_EXTERNAL_URL;
  let baseUrl: string;
  if (controlUrl) {
    baseUrl = controlUrl;
  } else {
    const host = request.headers.get('host') || '';
    const proto = request.headers.get('x-forwarded-proto') || 'http';
    baseUrl = `${proto}://${host}`;
  }

  const code = request.nextUrl.searchParams.get('code');
  const state = request.nextUrl.searchParams.get('state');
  const errorParam = request.nextUrl.searchParams.get('error');

  // Handle Authentik errors
  if (errorParam) {
    const desc = request.nextUrl.searchParams.get('error_description') || errorParam;
    console.error(`OAuth2 error: ${desc}`);
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(desc)}`, baseUrl));
  }

  if (!code || !state) {
    return NextResponse.redirect(new URL('/login?error=Missing+code+or+state', baseUrl));
  }

  // Verify state matches cookie
  const cookieStore = await cookies();
  const savedState = cookieStore.get('oauth-state')?.value;
  cookieStore.delete('oauth-state');

  if (!savedState || savedState !== state) {
    console.error('OAuth2 state mismatch');
    return NextResponse.redirect(new URL('/login?error=Invalid+state', baseUrl));
  }

  try {
    const redirectUri = `${baseUrl}/api/auth/callback`;

    // Exchange code for token
    const tokenData = await exchangeCodeForToken(code, redirectUri);

    // Fetch user info
    const userInfo = await fetchUserInfo(tokenData.access_token);

    const username = userInfo.preferred_username || userInfo.sub;
    const groups = userInfo.groups || [];
    const isAdmin = groups.includes(ADMIN_GROUP);

    // Create session
    const sessionToken = await createSession(username, isAdmin, groups);
    const csrfToken = generateCSRFToken();
    await setSessionCookies(sessionToken, csrfToken);

    console.log(`SSO login successful for "${username}" (admin: ${isAdmin})`);

    // Redirect to dashboard
    return NextResponse.redirect(new URL('/', baseUrl));
  } catch (error) {
    console.error('OAuth2 callback error:', error);
    const msg = error instanceof Error ? error.message : 'Authentication failed';
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, baseUrl));
  }
}
