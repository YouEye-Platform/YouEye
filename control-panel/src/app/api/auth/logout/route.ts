/**
 * Logout API Route
 * 
 * POST /api/auth/logout
 * Clears the session cookies
 */

import { NextRequest, NextResponse } from 'next/server';
import { clearSessionCookies, getSession } from '@/lib/auth';
import { getIdentitySessionId } from '@/lib/identity/http';
import { revokeIdentitySession } from '@/lib/identity/store';
import { getIdentityConfig } from '@/lib/identity/config';
import { SESSION_COOKIE as ID_SESSION_COOKIE } from '@/lib/identity/tokens';
import { queueSessionLogout } from '@/lib/identity/backchannel-logout';

export async function POST(request: NextRequest) {
  try {
    // Get current session for logging
    const session = await getSession();
    
    if (session) {
      console.log(`User "${session.username}" logged out`);
    }
    const identitySessionId = await getIdentitySessionId(request);
    if (identitySessionId && session?.authMethod === 'sso' && session.identitySessionId === identitySessionId) {
      await queueSessionLogout(identitySessionId);
      await revokeIdentitySession(identitySessionId);
    }

    // Clear cookies
    await clearSessionCookies();

    const response = NextResponse.json({ success: true });
    if (identitySessionId) {
      const config = await getIdentityConfig();
      response.cookies.set(ID_SESSION_COOKIE, '', { domain: config.cookieDomain, path: '/', maxAge: 0,
        httpOnly: true, secure: process.env.SECURE_COOKIES !== 'false', sameSite: 'lax' });
    }
    return response;
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
