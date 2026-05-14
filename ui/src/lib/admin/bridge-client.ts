/**
 * Bridge Token Reader
 *
 * Reads the shared bridge token from /etc/youeye/ui-bridge-token.
 * Used by the Control Panel→UI api routes to validate incoming requests from the
 * Control Panel. The UI no longer makes outbound bridge calls to the Control Panel.
 */

import { readFileSync } from "fs";

/** Cached bridge token (read once from file) */
let cachedToken: string | null = null;

/** Whether we already tried (and failed) to read the token file */
let tokenReadFailed = false;

/**
 * Read the bridge token from /etc/youeye/ui-bridge-token.
 * Caches the token in memory after the first successful read.
 * Returns null if the file doesn't exist or can't be read.
 */
export function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  if (tokenReadFailed) return null;

  try {
    const token = readFileSync("/etc/youeye/ui-bridge-token", "utf-8").trim();
    if (!token) {
      tokenReadFailed = true;
      return null;
    }
    cachedToken = token;
    return cachedToken;
  } catch {
    console.warn("[bridge-token] Could not read /etc/youeye/ui-bridge-token");
    tokenReadFailed = true;
    return null;
  }
}

/**
 * Clear the cached token (useful if the token file is updated).
 */
export function clearTokenCache(): void {
  cachedToken = null;
  tokenReadFailed = false;
}
