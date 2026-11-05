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

async function proxyToUI(method: string, body?: string) {
  const token = getBridgeToken();
  if (!token) return NextResponse.json({ error: "Bridge token unavailable" }, { status: 500 });

  try {
    const opts: RequestInit = {
      method,
      headers: { "X-UI-Bridge-Token": token, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    };
    if (body) opts.body = body;

    const res = await fetch(`${UI_BASE}/api/ui-bridge/wordart-presets`, opts);
    if (!res.ok) return NextResponse.json({ error: "UI bridge error" }, { status: res.status });
    return NextResponse.json(await res.json(), { status: res.status });
  } catch {
    return NextResponse.json({ error: "UI unreachable" }, { status: 502 });
  }
}

export async function GET() {
  return proxyToUI("GET");
}

export async function POST(request: NextRequest) {
  return proxyToUI("POST", await request.text());
}

export async function DELETE(request: NextRequest) {
  return proxyToUI("DELETE", await request.text());
}

export async function PATCH(request: NextRequest) {
  return proxyToUI("PATCH", await request.text());
}
