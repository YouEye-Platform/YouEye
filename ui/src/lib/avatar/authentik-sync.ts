/**
 * Authentik Avatar Sync
 *
 * @deprecated One-Way Bridge: This module is no longer used.
 * UI no longer calls CP. Avatars are stored locally in UI only.
 * Users can set their Authentik avatar directly via Authentik admin.
 *
 * Keeping this file for reference. Safe to delete in future cleanup.
 */

const BRIDGE_TOKEN_PATH = "/etc/youeye/ui-bridge-token";
const CP_INTERNAL_URL = process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

/**
 * @deprecated No longer used. See module deprecation notice.
 */
export async function syncAvatarToAuthentik(
  authentikId: string,
  imageBuffer: Buffer
): Promise<void> {
  let bridgeToken: string;
  try {
    const { readFile } = await import("fs/promises");
    bridgeToken = (await readFile(BRIDGE_TOKEN_PATH, "utf-8")).trim();
  } catch {
    // No bridge token — can't sync
    return;
  }

  const formData = new FormData();
  formData.append("authentikId", authentikId);
  formData.append(
    "file",
    new Blob([imageBuffer as BlobPart], { type: "image/webp" }),
    "avatar.webp"
  );

  const res = await fetch(`${CP_INTERNAL_URL}/api/ui-bridge/user/avatar`, {
    method: "POST",
    headers: {
      "X-UI-Bridge-Token": bridgeToken,
    },
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Authentik avatar sync failed (${res.status}): ${text}`);
  }
}
