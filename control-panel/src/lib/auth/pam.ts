/**
 * PAM Authentication Library
 * 
 * Uses Spine API to authenticate users against the host system PAM.
 * This allows the Control Panel to run unprivileged while still
 * supporting system user authentication.
 */

import { SpineClient } from '@/lib/spine/client';

interface PAMAuthResult {
  success: boolean;
  error?: string;
  user?: string;
  groups?: string[];
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

  // Sanitize username to prevent issues
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
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
