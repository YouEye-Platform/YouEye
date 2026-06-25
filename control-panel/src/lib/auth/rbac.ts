/**
 * Role-Based Access Control (RBAC)
 *
 * Provides helpers for route-level authorization based on user session.
 * Used by both API routes and embed pages.
 */

import { NextResponse } from 'next/server';
import { getSession, type SessionPayload } from './session';

export type Role = 'admin' | 'user' | 'public';

/**
 * Check if user session has admin role
 */
export function isAdminSession(session: SessionPayload | null): boolean {
  return session?.isAdmin === true;
}

/**
 * Require authentication - returns session or error response
 */
export async function requireAuth(): Promise<
  | { session: SessionPayload; error?: never }
  | { session?: never; error: NextResponse }
> {
  const session = await getSession();

  if (!session) {
    return {
      error: NextResponse.json(
        { error: 'Authentication required' },
        { status: 401 }
      ),
    };
  }

  return { session };
}

/**
 * Require admin role - returns session or error response
 */
export async function requireAdmin(): Promise<
  | { session: SessionPayload; error?: never }
  | { session?: never; error: NextResponse }
> {
  const result = await requireAuth();

  if (result.error) {
    return result;
  }

  if (!isAdminSession(result.session)) {
    return {
      error: NextResponse.json(
        { error: 'Admin access required' },
        { status: 403 }
      ),
    };
  }

  return result;
}

/**
 * Get session for embed pages - returns session or null
 * Embed pages should show a sign-in prompt if no session, not redirect
 */
export async function getEmbedSession(): Promise<SessionPayload | null> {
  return getSession();
}

/**
 * Check if session has required role for an embed
 */
export function checkEmbedAccess(
  session: SessionPayload | null,
  requiredRole: Role
): { allowed: boolean; reason?: string } {
  if (requiredRole === 'public') {
    return { allowed: true };
  }

  if (!session) {
    return { allowed: false, reason: 'Sign in required' };
  }

  if (requiredRole === 'admin' && !session.isAdmin) {
    return { allowed: false, reason: 'Admin access required' };
  }

  return { allowed: true };
}
