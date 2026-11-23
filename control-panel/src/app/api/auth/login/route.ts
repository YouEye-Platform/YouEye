/**
 * Login API Route
 * 
 * POST /api/auth/login
 * Authenticates user with PAM and creates a session
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  authenticatePAM,
  isAdmin,
  createSession,
  setSessionCookies,
  generateCSRFToken,
} from '@/lib/auth';
import { requestClientAddress } from '@/lib/auth/client-address';
import { beginSignInAttempt, signInSucceeded } from '@/lib/identity/sign-in-limit';

export async function POST(request: NextRequest) {
  try {
    // Parse request body
    const body = await request.json();
    const { username, password } = body;

    // Validate input (a form error is no guess and counts against nothing)
    if (!username || !password) {
      return NextResponse.json(
        { error: 'Username and password are required' },
        { status: 400 }
      );
    }

    if (typeof username !== 'string' || typeof password !== 'string') {
      return NextResponse.json(
        { error: 'Invalid input format' },
        { status: 400 }
      );
    }

    // Failures per username from any address, and per client address (the TCP peer; Caddy's X-Forwarded-For only
    // from Caddy). Loopback and unknown are no client address, so nobody can lock everyone out (YE-136).
    const ip = await requestClientAddress(request.headers);
    const attempt = beginSignInAttempt(username, ip, 'cp-login');

    if (!attempt.allowed) {
      const retryAfter = Math.max(1, Math.ceil((attempt.retryAt - Date.now()) / 1000));
      return NextResponse.json(
        {
          error: 'Too many login attempts. Please try again later.',
          retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
          },
        }
      );
    }

    // Authenticate with PAM
    const authResult = await authenticatePAM(username, password);

    if (!authResult.success) {
      // Log failed attempt (in production, send to audit log)
      console.warn(`Failed login attempt for user "${username}" from ${ip ?? 'a local or unknown address'}`);

      return NextResponse.json(
        {
          error: 'Invalid credentials',
          remaining: attempt.remaining,
        },
        { status: 401 }
      );
    }

    // Get user info - use groups from PAM auth result
    const groups = authResult.groups || [];
    const admin = await isAdmin(username, groups);

    // The username starts over, and the address gets its attempt back
    signInSucceeded(attempt);

    // Create session token
    const sessionToken = await createSession(username, admin, groups, 'pam');
    const csrfToken = generateCSRFToken();

    // Set cookies
    await setSessionCookies(sessionToken, csrfToken, { request, maxAge: 86400 });

    // Log successful login
    console.log(`Successful login for user "${username}" from ${ip ?? 'a local or unknown address'}`);

    return NextResponse.json({
      success: true,
      user: {
        username,
        isAdmin: admin,
        groups,
      },
      csrfToken,
    });
  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
