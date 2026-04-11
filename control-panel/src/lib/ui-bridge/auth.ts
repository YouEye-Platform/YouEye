/**
 * UI Bridge Authentication
 *
 * Validates shared service tokens for UI -> CP server-to-server communication.
 * The token is stored at /etc/youeye/ui-bridge-token and shared between
 * the Control Panel and YouEye UI containers.
 *
 * On first request, if the token file doesn't exist, a random 64-char
 * hex token is generated and saved.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';

const TOKEN_FILE_PATH = '/etc/youeye/ui-bridge-token';
const TOKEN_HEADER = 'X-UI-Bridge-Token';

/** Cached token to avoid repeated disk reads */
let cachedToken: string | null = null;

/**
 * Read or create the bridge token from the filesystem.
 * Generates a new 64-char hex token if the file doesn't exist.
 */
async function getBridgeToken(): Promise<string> {
  if (cachedToken) {
    return cachedToken;
  }

  try {
    const token = (await readFile(TOKEN_FILE_PATH, 'utf-8')).trim();
    if (token.length > 0) {
      cachedToken = token;
      return token;
    }
  } catch {
    // File doesn't exist or can't be read — generate a new token
  }

  // Generate a new 64-char hex token (32 random bytes)
  const newToken = randomBytes(32).toString('hex');

  try {
    await mkdir('/etc/youeye', { recursive: true });
    await writeFile(TOKEN_FILE_PATH, newToken, { mode: 0o600 });
    console.log('[UI Bridge] Generated new bridge token');
  } catch (err) {
    console.error('[UI Bridge] Failed to write token file:', err);
    // Still return the token for this session even if writing fails
  }

  cachedToken = newToken;
  return newToken;
}

/**
 * Validate the bridge token from the request headers.
 * Returns null if valid, or a NextResponse with 401 status if invalid.
 *
 * Usage in route handlers:
 * ```
 * const authError = await validateBridgeToken(request);
 * if (authError) return authError;
 * ```
 */
export async function validateBridgeToken(
  request: Request
): Promise<NextResponse | null> {
  const providedToken = request.headers.get(TOKEN_HEADER);

  if (!providedToken) {
    return NextResponse.json(
      { error: 'Missing authentication token', valid: false },
      { status: 401 }
    );
  }

  try {
    const expectedToken = await getBridgeToken();

    if (providedToken !== expectedToken) {
      return NextResponse.json(
        { error: 'Invalid authentication token', valid: false },
        { status: 401 }
      );
    }

    return null; // Token is valid
  } catch (err) {
    console.error('[UI Bridge] Token validation error:', err);
    return NextResponse.json(
      { error: 'Authentication service error', valid: false },
      { status: 500 }
    );
  }
}

/**
 * Clear the cached token (useful for testing or rotation).
 */
export function clearTokenCache(): void {
  cachedToken = null;
}
