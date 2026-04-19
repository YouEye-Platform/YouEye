import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";

const TOKEN_FILE_PATH = "/etc/youeye/ui-bridge-token";
const UI_BASE = `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;

let cachedToken: string | null = null;

function getBridgeToken(): string | null {
  if (cachedToken) return cachedToken;
  try {
    cachedToken = readFileSync(TOKEN_FILE_PATH, "utf-8").trim();
    return cachedToken;
  } catch {
    return null;
  }
}

export async function GET() {
  const token = getBridgeToken();
  if (!token) return NextResponse.json({ error: "Bridge token unavailable" }, { status: 500 });

  try {
    const res = await fetch(`${UI_BASE}/api/ui-bridge/branding`, {
      headers: { "X-UI-Bridge-Token": token },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return NextResponse.json({ error: "UI bridge error" }, { status: res.status });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: "UI unreachable" }, { status: 502 });
  }
}

export async function PUT(request: NextRequest) {
  const token = getBridgeToken();
  if (!token) return NextResponse.json({ error: "Bridge token unavailable" }, { status: 500 });

  try {
    const body = await request.json();
    const res = await fetch(`${UI_BASE}/api/ui-bridge/branding`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-UI-Bridge-Token": token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return NextResponse.json({ error: "UI bridge error" }, { status: res.status });
    const result = await res.json();

    // Sync to Authentik login page (best-effort, fire-and-forget)
    fetch(`http://localhost:3000/api/ui-bridge/authentik/branding`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-UI-Bridge-Token": token },
      body: "{}",
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});

    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "UI unreachable" }, { status: 502 });
  }
}
