/**
 * User Self-Profile API
 *
 * GET  /api/user/profile — Get current user's profile from Authentik
 * PATCH /api/user/profile — Update current user's own name in Authentik
 *
 * This endpoint is available to ALL authenticated users (not admin-only).
 * Users can only modify their own profile — the username comes from the
 * session JWT, not from the request body.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listUsers, updateUser } from "@/lib/authentik/client";
import { getContainerIP } from "@/lib/incus/container-ip";
import { readFile } from "fs/promises";

const BRIDGE_TOKEN_PATH = "/etc/youeye/ui-bridge-token";

/**
 * Find an Authentik user by their username (exact match).
 */
async function findAuthentikUser(username: string) {
  const result = await listUsers({ search: username, page_size: 10 });
  return result.results?.find((u) => u.username === username) ?? null;
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const user = await findAuthentikUser(session.username);
    if (!user) {
      return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });
    }

    // Split the "name" field into first/last for the UI
    const nameParts = (user.name || "").split(" ", 2);
    const firstName = nameParts[0] || "";
    const lastName = nameParts.length > 1 ? user.name.substring(firstName.length + 1) : "";

    // Extract avatar from Authentik user attributes (stored as data URL)
    const avatarUrl = typeof user.attributes?.avatar === "string"
      ? user.attributes.avatar
      : undefined;

    return NextResponse.json({
      username: user.username,
      firstName,
      lastName,
      email: user.email,
      isAdmin: session.isAdmin,
      avatarUrl,
    });
  } catch (error) {
    console.error("Failed to fetch user profile:", error);
    return NextResponse.json({ error: "Failed to fetch profile" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { firstName?: string; lastName?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Validate: only firstName and lastName are allowed
  const firstName = typeof body.firstName === "string" ? body.firstName.trim() : undefined;
  const lastName = typeof body.lastName === "string" ? body.lastName.trim() : undefined;

  if (firstName === undefined && lastName === undefined) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  try {
    const user = await findAuthentikUser(session.username);
    if (!user) {
      return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });
    }

    // Build the combined "name" field for Authentik
    // Preserve existing parts if only one field is being updated
    const currentParts = (user.name || "").split(" ", 2);
    const currentFirst = currentParts[0] || "";
    const currentLast = currentParts.length > 1 ? user.name.substring(currentFirst.length + 1) : "";

    const newFirst = firstName !== undefined ? firstName : currentFirst;
    const newLast = lastName !== undefined ? lastName : currentLast;
    const fullName = [newFirst, newLast].filter(Boolean).join(" ") || user.username;

    await updateUser(user.pk, { name: fullName });

    // Push name change to UI via bridge (server-to-server, non-fatal)
    pushNameToUI(session.username, newFirst, newLast).catch((err) =>
      console.warn("[Profile] Bridge name push failed (non-fatal):", err instanceof Error ? err.message : err)
    );

    return NextResponse.json({
      username: user.username,
      firstName: newFirst,
      lastName: newLast,
      email: user.email,
      isAdmin: session.isAdmin,
    });
  } catch (error) {
    console.error("Failed to update user profile:", error);
    return NextResponse.json({ error: "Failed to update profile" }, { status: 500 });
  }
}

/**
 * Push name change to YE-UI via bridge so it persists in the UI database.
 * Non-fatal: if the bridge push fails, the postMessage client-side path
 * is the primary sync mechanism for names.
 */
async function pushNameToUI(
  username: string,
  firstName: string,
  lastName: string
): Promise<void> {
  const token = (await readFile(BRIDGE_TOKEN_PATH, "utf-8")).trim();
  const uiIP = await getContainerIP("youeye-ui");
  if (!uiIP || !token) return;

  const res = await fetch(`http://${uiIP}:3000/api/ui-bridge/user-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-UI-Bridge-Token": token,
    },
    body: JSON.stringify({ username, firstName, lastName }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.warn(`[Profile] Bridge push failed: ${res.status} ${text}`);
  }
}
