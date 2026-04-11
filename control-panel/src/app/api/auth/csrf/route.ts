/**
 * CSRF Token API
 * 
 * Returns the CSRF token for the current session.
 * The token is already set as a cookie during login, but some
 * pages fetch it via API for compatibility.
 */

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

const CSRF_COOKIE = 'ye-csrf';

/**
 * GET /api/auth/csrf - Get the CSRF token for the current session
 */
export async function GET() {
  try {
    const cookieStore = await cookies();
    const csrfCookie = cookieStore.get(CSRF_COOKIE);
    
    if (!csrfCookie?.value) {
      return NextResponse.json({ csrfToken: null });
    }

    return NextResponse.json({ csrfToken: csrfCookie.value });
  } catch (error) {
    console.error('Error getting CSRF token:', error);
    return NextResponse.json(
      { error: 'Failed to get CSRF token' },
      { status: 500 }
    );
  }
}
