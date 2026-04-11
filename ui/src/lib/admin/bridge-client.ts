/**
 * Admin Bridge Client
 *
 * Handles communication with the Control Panel's UI bridge API.
 * Reads the shared bridge token from /etc/youeye/ui-bridge-token
 * and forwards requests to the CP's internal Incus address.
 */

import { readFileSync } from "fs";

/** Control Panel base URL via Incus internal network */
const CP_BASE_URL = "http://youeye-control.incus:3000/api/ui-bridge";

/** Request timeout in milliseconds (default: 15s, SSE: 5 min) */
const BRIDGE_TIMEOUT = 15_000;
const BRIDGE_TIMEOUT_SSE = 300_000;

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
    console.warn("[admin-bridge] Could not read /etc/youeye/ui-bridge-token");
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

/**
 * Forward a request to the Control Panel's UI bridge API.
 *
 * @param path - The path after /api/ui-bridge/ (e.g., "system", "containers")
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns The CP response
 * @throws Error if the bridge token is not available or CP is unreachable
 */
export async function bridgeRequest(
  path: string,
  options?: RequestInit & { sseTimeout?: boolean }
): Promise<Response> {
  const token = getBridgeToken();

  if (!token) {
    throw new BridgeError(
      "Bridge token not configured. The UI bridge token file (/etc/youeye/ui-bridge-token) is missing or empty.",
      "TOKEN_MISSING"
    );
  }

  const url = `${CP_BASE_URL}/${path}`;

  const controller = new AbortController();
  const timeoutMs = options?.sseTimeout ? BRIDGE_TIMEOUT_SSE : BRIDGE_TIMEOUT;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-UI-Bridge-Token": token,
        ...options?.headers,
      },
    });

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new BridgeError(
        "Control Panel did not respond within 15 seconds.",
        "TIMEOUT"
      );
    }

    throw new BridgeError(
      "Control Panel is not reachable. It may be offline or the network connection is unavailable.",
      "UNREACHABLE"
    );
  } finally {
    clearTimeout(timeout);
  }
}

/** Custom error type for bridge failures */
export class BridgeError extends Error {
  public readonly code: "TOKEN_MISSING" | "TIMEOUT" | "UNREACHABLE";

  constructor(
    message: string,
    code: "TOKEN_MISSING" | "TIMEOUT" | "UNREACHABLE"
  ) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
  }
}
