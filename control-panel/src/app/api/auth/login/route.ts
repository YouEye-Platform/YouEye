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
  checkRateLimit,
  resetRateLimit,
} from '@/lib/auth';

// Rate limiting configuration
const LOGIN_MAX_ATTEMPTS = 20;
const LOGIN_WINDOW_SECONDS = 300; // 5 minutes

export async function POST(request: NextRequest) {
  try {
    // Get client IP for rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() 
      || request.headers.get('x-real-ip') 
      || 'unknown';
    
    // Check rate limit
    const rateLimitKey = `login:${ip}`;
    const rateLimit = checkRateLimit(rateLimitKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_SECONDS);
    
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { 
          error: 'Too many login attempts. Please try again later.',
          retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000),
        },
        { 
          status: 429,
          headers: {
            'Retry-After': String(Math.ceil((rateLimit.resetAt - Date.now()) / 1000)),
          },
        }
      );
    }

    // Parse request body
    const body = await request.json();
    const { username, password } = body;

    // Validate input
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

    // Authenticate with PAM
    const authResult = await authenticatePAM(username, password);

    if (!authResult.success) {
      // Log failed attempt (in production, send to audit log)
      console.warn(`Failed login attempt for user "${username}" from IP ${ip}`);
      
      return NextResponse.json(
        { 
          error: 'Invalid credentials',
          remaining: rateLimit.remaining,
        },
        { status: 401 }
      );
    }

    // Get user info - use groups from PAM auth result
    const groups = authResult.groups || [];
    const admin = await isAdmin(username, groups);

    // Reset rate limit on successful login
    resetRateLimit(rateLimitKey);

    // Create session token
    const sessionToken = await createSession(username, admin, groups);
    const csrfToken = generateCSRFToken();

    // Set cookies
    await setSessionCookies(sessionToken, csrfToken);

    // Log successful login
    console.log(`Successful login for user "${username}" from IP ${ip}`);

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
