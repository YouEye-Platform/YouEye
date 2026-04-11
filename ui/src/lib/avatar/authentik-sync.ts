/**
 * Authentik Avatar Sync
 *
 * Sends the user's avatar to Authentik via the CP bridge endpoint.
 * This is best-effort — failure doesn't block the upload.
 */

const BRIDGE_TOKEN_PATH = "/etc/youeye/ui-bridge-token";
const CP_INTERNAL_URL = process.env.CP_INTERNAL_URL || "http://youeye-control.incus:3000";

/**
 * Sync avatar to Authentik via the Control Panel bridge.
 * Sends the avatar image to the CP which forwards it to Authentik's API.
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
