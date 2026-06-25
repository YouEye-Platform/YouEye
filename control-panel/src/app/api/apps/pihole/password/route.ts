/**
 * Pi-Hole Password Management API
 *
 * Allows admins to check and change Pi-Hole password securely.
 * Passwords are stored in systemd environment variables.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { getPiholePassword, setPiholePassword, hasCustomPiholePassword } from '@/lib/apps/secrets';
import { clearPiholeSession } from '@/lib/apps/pihole-api';

/**
 * GET - Check if custom password is set
 */
export async function GET() {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const hasCustomPassword = await hasCustomPiholePassword();

    return NextResponse.json({
      hasCustomPassword,
      message: hasCustomPassword
        ? 'Custom password is configured'
        : 'Using default password — change it in Settings',
    });
  } catch (error) {
    console.error('Error checking password:', error);
    return NextResponse.json({ error: 'Failed to check password status' }, { status: 500 });
  }
}

/**
 * POST - Change Pi-Hole password
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized - no valid session' }, { status: 401 });
    }

    if (!session.isAdmin) {
      return NextResponse.json(
        { error: 'Admin access required - you must be an administrator to change passwords' },
        { status: 403 }
      );
    }

    const csrfToken = request.headers.get('X-CSRF-Token');
    if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
      return NextResponse.json(
        { error: 'Invalid or missing CSRF token - please refresh the page and try again' },
        { status: 403 }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: 'Invalid request body - expected JSON with newPassword field' },
        { status: 400 }
      );
    }

    const { newPassword } = body;

    if (newPassword === undefined || newPassword === null) {
      return NextResponse.json({ error: 'Missing newPassword field in request body' }, { status: 400 });
    }

    if (typeof newPassword !== 'string') {
      return NextResponse.json({ error: 'Invalid password type - expected a string' }, { status: 400 });
    }

    if (newPassword.length === 0) {
      return NextResponse.json({ error: 'Password cannot be empty' }, { status: 400 });
    }

    if (newPassword.length < 8) {
      return NextResponse.json(
        { error: `Password must be at least 8 characters (currently ${newPassword.length})` },
        { status: 400 }
      );
    }

    // Clear cached session before password change
    clearPiholeSession();

    // Update password
    await setPiholePassword(newPassword);

    console.log(`[Pi-Hole] Password changed by ${session.username}`);

    return NextResponse.json({
      success: true,
      message: 'Password updated successfully. Pi-Hole container restarted.',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    console.error('Error changing password:', error);
    return NextResponse.json({ error: `Failed to change password: ${errorMessage}` }, { status: 500 });
  }
}
