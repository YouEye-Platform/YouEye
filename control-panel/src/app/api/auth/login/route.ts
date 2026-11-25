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
  isValidPAMUsername,
  createSession,
  setSessionCookies,
  generateCSRFToken,
} from '@/lib/auth';
import { requestClientAddress } from '@/lib/auth/client-address';
import { beginSignInAttempt, signInNotCounted, signInRetryAfterSeconds, signInSucceeded, type SignInAttempt } from '@/lib/identity/sign-in-limit';

export async function POST(request: NextRequest) {
  let attempt: SignInAttempt | null = null;
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

    // No account can have such a name (YE-169: at most 32 characters, no leading `-`): a form error, counted nowhere.
    if (!isValidPAMUsername(username)) {
      return NextResponse.json({ error: 'Invalid username format' }, { status: 400 });
    }

    // Failures per (username, client address) and per client address lock; per username they only slow down
    // (`sign-in-limit.ts`, YE-149). The client address is the TCP peer, Caddy's X-Forwarded-For only from Caddy.
    const ip = await requestClientAddress(request.headers);
    attempt = beginSignInAttempt(username, ip, 'cp-login');

    if (!attempt.allowed) {
      const retryAfter = signInRetryAfterSeconds(attempt);
      return NextResponse.json(
        {
          error: attempt.refusal === 'wait'
            ? `Too many login attempts. Please try again in ${retryAfter} seconds.`
            : 'Too many login attempts. Please try again later.',
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

    // Spine refused to check the password (YE-164): its own limit (429) or a full PAM queue (503). That is no guess
    // and no answer about the password, so it counts nothing here and says when to try again, never "Invalid
    // credentials".
    if (authResult.rateLimited) {
      signInNotCounted(attempt);
      const retryAfter = authResult.retryAfter ?? 300;
      return NextResponse.json(
        { error: `Too many login attempts. Please try again in ${retryAfter} seconds.`, retryAfter },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } },
      );
    }

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
    // A failure of ours is no guess: it counts against nothing (a settled attempt stays settled).
    if (attempt) signInNotCounted(attempt);
    console.error('Login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
