/**
 * User Avatar API — CP-owned
 *
 * POST   /api/user/avatar — upload avatar to Authentik
 * DELETE /api/user/avatar — remove avatar from Authentik
 *
 * Available to all authenticated users. The avatar is stored in Authentik
 * and propagated to SSO apps via the OIDC `picture` claim.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { listUsers } from "@/lib/authentik/client";
import { spineClient } from "@/lib/spine/client";
import { getContainerIP } from "@/lib/incus/container-ip";

const MAX_INPUT_SIZE = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];

async function findAuthentikUser(username: string) {
  const result = await listUsers({ search: username, page_size: 10 });
  return result.results?.find((u) => u.username === username) ?? null;
}

async function getAuthentikUrl(): Promise<{ url: string; token: string }> {
  const creds = await spineClient.getAuthentikCredentials();
  const ip = await getContainerIP("youeye-authentik");
  const url = ip ? `http://${ip}:9000` : creds.internal_url;
  return { url, token: creds.bootstrap_token };
}

async function getExistingAttributes(
  authentikUrl: string,
  token: string,
  pk: number
): Promise<Record<string, unknown>> {
  try {
    const res = await fetch(`${authentikUrl}/api/v3/core/users/${pk}/`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) return {};
    const user = await res.json();
    return user.attributes || {};
  } catch {
    return {};
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

    const user = await findAuthentikUser(session.username);
    if (!user) {
      return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });
    }

    const { url: authentikUrl, token } = await getAuthentikUrl();

    // Convert file to base64 data URL and store in Authentik user attributes
    const buffer = Buffer.from(await file.arrayBuffer());
    const dataUrl = `data:${file.type};base64,${buffer.toString("base64")}`;

    const res = await fetch(
      `${authentikUrl}/api/v3/core/users/${user.pk}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          attributes: { ...((await getExistingAttributes(authentikUrl, token, user.pk)) || {}), avatar: dataUrl },
        }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Authentik avatar upload failed: ${res.status} ${text}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Avatar] Upload to Authentik failed:", error);
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
    const user = await findAuthentikUser(session.username);
    if (!user) {
      return NextResponse.json({ error: "User not found in Authentik" }, { status: 404 });
    }

    const { url: authentikUrl, token } = await getAuthentikUrl();

    // Remove avatar from user attributes (falls back to initials)
    const existing = await getExistingAttributes(authentikUrl, token, user.pk);
    delete existing.avatar;

    const res = await fetch(
      `${authentikUrl}/api/v3/core/users/${user.pk}/`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ attributes: existing }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Authentik avatar removal failed: ${res.status} ${text}` },
        { status: 502 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Avatar] Removal from Authentik failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed" },
      { status: 500 }
    );
  }
}
