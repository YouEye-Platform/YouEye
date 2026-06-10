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
): Promise<void> {
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
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : "UI avatar sync failed");
  }
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
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

    await pushAvatarToUI(session.username, dataUrl);

    return NextResponse.json({ success: true });
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
