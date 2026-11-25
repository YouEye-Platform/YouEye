/**
 * PAM Authentication Library
 * 
 * Uses Spine API to authenticate users against the host system PAM.
 * This allows the Control Panel to run unprivileged while still
 * supporting system user authentication.
 */

import { SpineAPIError, SpineClient } from '@/lib/spine/client';

interface PAMAuthResult {
  success: boolean;
  /**
   * Spine refused to check the password: HTTP 429 (its per-username attempt limit) or 503 (its PAM queue is full).
   * That is no answer about the password. `retryAfter` is in seconds.
   */
  rateLimited?: boolean;
  retryAfter?: number;
  error?: string;
  user?: string;
  groups?: string[];
}

/**
 * A sign-in username (YE-169): the characters accepted before, at most 32 (the Linux limit), never a leading `-`
 * (it would be read as an option by the tools Spine runs). Spine checks the same rule (`usernamePattern`).
 */
export const PAM_USERNAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,31}$/;

export function isValidPAMUsername(username: unknown): username is string {
  return typeof username === 'string' && PAM_USERNAME.test(username);
}

// Use a dedicated Spine client for auth
const spineClient = new SpineClient();

/**
 * Authenticate a user using Linux PAM via Spine API
 * 
 * @param username - The Linux username
 * @param password - The user's password
 * @returns Authentication result
 */
export async function authenticatePAM(
  username: string,
  password: string
): Promise<PAMAuthResult> {
  // Basic input validation
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' };
  }

  if (!isValidPAMUsername(username)) {
    return { success: false, error: 'Invalid username format' };
  }

  try {
    const result = await spineClient.verifyAuth(username, password);
    
    if (result.authenticated) {
      return { 
        success: true, 
        user: result.username,
        groups: result.groups 
      };
    } else {
      return { success: false, error: 'Authentication failed' };
    }
  } catch (error) {
    if (error instanceof SpineAPIError && (error.statusCode === 429 || error.statusCode === 503)) {
      return { success: false, rateLimited: true, retryAfter: spineRetryAfterSeconds(error), error: 'Too many attempts' };
    }
    console.error('PAM auth error:', error);
    
    // Check if Spine is available
    const available = await spineClient.isAvailable();
    if (!available) {
      return { success: false, error: 'Authentication service unavailable' };
    }
    
    return { success: false, error: 'Authentication system error' };
  }
}

/**
 * Seconds until Spine checks passwords again: its `Retry-After` (seconds), else its `X-RateLimit-Reset` (Unix
 * seconds), else the minutes in its message ("please wait 5 minutes"), else 5 minutes. At least 1, at most an hour.
 */
export function spineRetryAfterSeconds(error: SpineAPIError, now = Date.now()): number {
  const header = (name: string) => {
    const value = error.headers?.[name];
    return Number(Array.isArray(value) ? value[0] : value ?? NaN);
  };
  const retryAfter = header('retry-after');
  const reset = header('x-ratelimit-reset');
  let seconds = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.ceil(retryAfter)
    : Number.isFinite(reset) && reset > 0 ? Math.ceil(reset - now / 1000) : NaN;
  if (!Number.isFinite(seconds)) {
    const minutes = /wait (\d+) minute/.exec(error.message)?.[1];
    seconds = minutes ? Number(minutes) * 60 : 300;
  }
  return Math.min(3600, Math.max(1, seconds));
}

/**
 * Get user groups - Groups are returned from login
 * This is a placeholder for backwards compatibility
 */
export async function getUserGroups(username: string): Promise<string[]> {
  // Groups are returned during authentication
  // This function is kept for backwards compatibility
  console.log(`getUserGroups called for ${username} - use groups from login result`);
  return [];
}

/**
 * Check if user has admin privileges (root or in admin groups)
 */
export async function isAdmin(username: string, groups?: string[]): Promise<boolean> {
  if (username === 'root') {
    return true;
  }

  // If groups provided (from login), use those
  if (groups && groups.length > 0) {
    return groups.some(g => 
      ['incus-admin', 'sudo', 'wheel', 'root'].includes(g)
    );
  }

  return false;
}
