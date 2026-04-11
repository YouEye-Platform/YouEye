/**
 * Logout API Route
 * 
 * POST /api/auth/logout
 * Clears the session cookies
 */

import { NextResponse } from 'next/server';
import { clearSessionCookies, getSession } from '@/lib/auth';

export async function POST() {
  try {
    // Get current session for logging
    const session = await getSession();
    
    if (session) {
      console.log(`User "${session.username}" logged out`);
    }

    // Clear cookies
    await clearSessionCookies();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Logout error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
