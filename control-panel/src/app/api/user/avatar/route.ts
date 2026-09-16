/**
 * User Avatar API — CP-owned bridge to UI
 *
 * POST   /api/user/avatar — upload avatar to UI via bridge
 * DELETE /api/user/avatar — remove avatar from UI via bridge
 *
 * Available to all authenticated users. The identity provider does not store profile
 * images; the UI database is the durable user-facing profile store.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getContainerIP } from "@/lib/incus/container-ip";
import { readFile } from "fs/promises";
import { join } from "path";
import { getProfileIconPreset } from "@/lib/profile-icon-presets";

const MAX_INPUT_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const BRIDGE_TOKEN_PATH = "/etc/youeye/ui-bridge-token";

/**
 * Push avatar data to YE-UI via the bridge so it persists in the UI database.
 * Avatar changes are not considered complete unless the UI mirror succeeds.
 */
async function pushAvatarToUI(
  username: string,
  dataUrl: string | null
): Promise<string | null> {
  try {
    const token = (await readFile(BRIDGE_TOKEN_PATH, "utf-8")).trim();
    const uiIP = await getContainerIP("youeye-ui");
    if (!uiIP || !token) {
      throw new Error("UI bridge unavailable");
    }

    const baseUrl = `http://${uiIP}:3000`;
    const method = dataUrl ? "POST" : "DELETE";
    const body = dataUrl
      ? JSON.stringify({ username, dataUrl })
      : JSON.stringify({ username });

    const res = await fetch(`${baseUrl}/api/ui-bridge/user-avatar`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-UI-Bridge-Token": token,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`UI avatar sync failed: ${res.status} ${text}`);
    }
    const response = await res.json().catch(() => ({}));
    return typeof response.url === "string" ? response.url : null;
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "UI avatar sync failed");
  }
}

function escapeXml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function renderPresetDataUrl(presetId: string): Promise<string | null> {
  const preset = getProfileIconPreset(presetId);
  if (!preset) return null;

  // Keep preset rendering independent of the browser/guest emoji font set. The
  // packaged transparent artwork is embedded into the stored SVG, so avatars
  // remain identical in onboarding, Settings, the UI, and connected apps.
  const artwork = await readFile(join(process.cwd(), "public", "profile-avatar-art", `${preset.id}.png`));
  const artworkDataUrl = `data:image/png;base64,${artwork.toString("base64")}`;

  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">',
    '<defs><linearGradient id="avatar-bg" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="${escapeXml(preset.background[0])}"/>`,
    `<stop offset="1" stop-color="${escapeXml(preset.background[1])}"/>`,
    "</linearGradient></defs>",
    '<circle cx="128" cy="128" r="128" fill="url(#avatar-bg)"/>',
    `<image href="${artworkDataUrl}" x="50" y="50" width="156" height="156" preserveAspectRatio="xMidYMid meet"/>`,
    "</svg>",
  ].join("");
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    if (request.headers.get("content-type")?.includes("application/json")) {
      const body = await request.json().catch(() => ({}));
      const presetId = typeof body.presetId === "string" ? body.presetId : "";
      const dataUrl = await renderPresetDataUrl(presetId);
      if (!dataUrl) return NextResponse.json({ error: "Unknown profile icon" }, { status: 400 });
      const url = await pushAvatarToUI(session.username, dataUrl);
      return NextResponse.json({ success: true, presetId, url });
    }

    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: "Invalid file type. Accepted: JPEG, PNG, WebP, GIF" },
        { status: 400 }
      );
    }

    if (file.size > MAX_INPUT_SIZE) {
      return NextResponse.json(
        { error: "File too large. Maximum 5MB" },
        { status: 400 }
      );
    }

    // Convert file to base64 data URL and store it in the UI profile mirror.
    const buffer = Buffer.from(await file.arrayBuffer());
    const dataUrl = `data:${file.type};base64,${buffer.toString("base64")}`;

    const url = await pushAvatarToUI(session.username, dataUrl);

    return NextResponse.json({ success: true, url });
  } catch (error) {
    console.error("[Avatar] Upload failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await pushAvatarToUI(session.username, null);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Avatar] Removal failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500 }
    );
  }
}
