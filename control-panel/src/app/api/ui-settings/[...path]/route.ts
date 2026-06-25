import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "fs";
import { CONTAINER_DOMAIN } from "@/lib/market/constants";
import { getSession } from "@/lib/auth/session";

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

async function proxy(request: NextRequest, path: string[]) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const token = getBridgeToken();
  if (!token) {
    return NextResponse.json({ error: "Bridge token unavailable" }, { status: 500 });
  }

  const suffix = path.map(encodeURIComponent).join("/");
  const url = new URL(`${UI_BASE}/api/ui-bridge/settings/${suffix}`);
  request.nextUrl.searchParams.forEach((value, key) => url.searchParams.set(key, value));

  const headers: Record<string, string> = {
    "X-UI-Bridge-Token": token,
    "X-YouEye-Username": session.username,
    "X-YouEye-Is-Admin": session.isAdmin ? "true" : "false",
  };

  const publicHost = request.headers.get("x-forwarded-host") || request.headers.get("host");
  const publicProto = request.headers.get("x-forwarded-proto") || new URL(request.url).protocol.replace(":", "") || "https";
  if (publicHost) headers["X-YouEye-Public-Host"] = publicHost;
  if (publicProto) headers["X-YouEye-Public-Proto"] = publicProto;

  const contentType = request.headers.get("content-type");
  if (contentType) headers["Content-Type"] = contentType;

  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();

  const res = await fetch(url, {
    method: request.method,
    headers,
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });

  const responseBody = await res.arrayBuffer();
  return new NextResponse(responseBody, {
    status: res.status,
    headers: {
      "Content-Type": res.headers.get("content-type") || "application/json",
    },
  });
}

type RouteContext = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PUT(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).path);
}
