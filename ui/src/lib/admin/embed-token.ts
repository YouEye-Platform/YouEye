/**
 * Embed Token Generator — server-side only.
 *
 * Signs iframe URLs using the bridge token as HMAC key.
 * CP validates these tokens before rendering embed pages.
 */

import { createHmac } from "crypto";
import { readFileSync } from "fs";

const TOKEN_FILE_PATH = "/etc/youeye/ui-bridge-token";

let cachedToken: string | null = null;
let tokenReadFailed = false;

function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  if (tokenReadFailed) return null;
  try {
    const token = readFileSync(TOKEN_FILE_PATH, "utf-8").trim();
    if (!token) {
      tokenReadFailed = true;
      return null;
    }
    cachedToken = token;
    return cachedToken;
  } catch {
    tokenReadFailed = true;
    return null;
  }
}

export function getSignedEmbedUrl(
  section: string,
  username: string,
  isAdmin: boolean,
  extraParams?: Record<string, string>
): string | null {
  const bridgeToken = getBridgeToken();
  if (!bridgeToken) return null;

  const cpBase = process.env.CP_EMBED_URL || "https://control.devvm.test";
  const ts = Math.floor(Date.now() / 1000);
  const adminFlag = isAdmin ? "1" : "0";
  const payload = `embed:${username}:${adminFlag}:${ts}`;
  const sig = createHmac("sha256", bridgeToken).update(payload).digest("hex");

  const params = new URLSearchParams({
    user: username,
    admin: adminFlag,
    ts: String(ts),
    sig,
    ...extraParams,
  });

  return `${cpBase}/embed/${section}?${params.toString()}`;
}
