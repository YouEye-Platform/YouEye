/**
 * Embed Authentication — HMAC-signed URL tokens.
 *
 * YE-UI signs iframe URLs using the shared bridge token as HMAC key.
 * CP validates the signature before rendering embed pages.
 * Tokens expire after 5 minutes.
 */

import { createHmac } from "crypto";
import { readFile } from "fs/promises";

const TOKEN_FILE_PATH = "/etc/youeye/ui-bridge-token";
const TOKEN_TTL_SECONDS = 300;

let cachedToken: string | null = null;

async function getBridgeToken(): Promise<string | null> {
  if (cachedToken) return cachedToken;
  try {
    const token = (await readFile(TOKEN_FILE_PATH, "utf-8")).trim();
    if (token.length > 0) {
      cachedToken = token;
      return token;
    }
  } catch {
    // Token file not available
  }
  return null;
}

export interface EmbedUser {
  username: string;
  isAdmin: boolean;
}

/**
 * Validate an HMAC-signed embed token from URL search params.
 * Expected params: user, admin, ts, sig
 */
export async function validateEmbedToken(
  searchParams: URLSearchParams
): Promise<EmbedUser | null> {
  const user = searchParams.get("user");
  const admin = searchParams.get("admin");
  const tsStr = searchParams.get("ts");
  const sig = searchParams.get("sig");

  if (!user || !admin || !tsStr || !sig) return null;

  const ts = parseInt(tsStr, 10);
  if (isNaN(ts)) return null;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TOKEN_TTL_SECONDS) return null;

  const bridgeToken = await getBridgeToken();
  if (!bridgeToken) return null;

  const payload = `embed:${user}:${admin}:${ts}`;
  const expected = createHmac("sha256", bridgeToken)
    .update(payload)
    .digest("hex");

  if (sig !== expected) return null;

  return { username: user, isAdmin: admin === "1" };
}

export function clearEmbedTokenCache(): void {
  cachedToken = null;
}
