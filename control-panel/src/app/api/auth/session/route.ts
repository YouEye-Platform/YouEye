/**
 * Session API Route
 * 
 * GET /api/auth/session
 * Returns current session info if authenticated
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';

export async function GET() {
  try {
    const session = await getSession();

    if (!session) {
      return NextResponse.json(
        { authenticated: false },
        { status: 401 }
      );
    }

    return NextResponse.json({
      authenticated: true,
      user: {
        username: session.username,
        isAdmin: session.isAdmin,
        groups: session.groups,
      },
      expiresAt: session.exp ? new Date(session.exp * 1000).toISOString() : null,
    });
  } catch (error) {
    console.error('Session check error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
