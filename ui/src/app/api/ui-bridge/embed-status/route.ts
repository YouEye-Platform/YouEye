/**
 * Embed Status — receives CP restart notifications.
 *
 * Control Panel calls this before restarting so UI can show skeleton loaders.
 * Validates via bridge token (same as other ui-bridge endpoints).
 */

import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";

const TOKEN_FILE_PATH = "/etc/youeye/ui-bridge-token";
let cachedToken: string | null = null;

function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync(TOKEN_FILE_PATH, "utf-8").trim() || null;
  } catch {
    return null;
  }
  return cachedToken;
}

export type EmbedStatus = {
  status: "ready" | "restarting";
  component: string;
  timestamp: number;
};

let currentStatus: EmbedStatus = {
  status: "ready",
  component: "",
  timestamp: Date.now(),
};

export function getEmbedStatus(): EmbedStatus {
  return currentStatus;
}

export async function POST(request: NextRequest) {
  const token = request.headers.get("X-UI-Bridge-Token");
  const expected = getBridgeToken();

  if (!token || !expected || token !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();
    currentStatus = {
      status: body.status || "ready",
      component: body.component || "",
      timestamp: Date.now(),
    };
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
}

export async function GET() {
  return NextResponse.json(currentStatus);
}
