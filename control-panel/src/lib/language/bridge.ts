import { readFileSync } from "fs";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";

/** Read bridge token for calling YE-UI */
let cachedToken: string | null = null;
function getBridgeToken(): string {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync("/etc/youeye/ui-bridge-token", "utf-8").trim();
    return cachedToken;
  } catch {
    return "";
  }
}

/**
 * Push language change to YE-UI.
 * One-way bridge: CP pushes to UI, UI stores locally.
 */
export async function pushLanguageToUI(language: string): Promise<void> {
  const token = getBridgeToken();
  if (!token) {
    throw new Error("UI language bridge is unavailable");
  }

  const uiUrl = process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

  try {
    const res = await fetch(`${uiUrl}/api/ui-bridge/language`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-UI-Bridge-Token": token,
      },
      body: JSON.stringify({ language }),
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      throw new Error(`UI language push failed: ${res.status}`);
    }
  } catch (err) {
    throw err;
  }
}
