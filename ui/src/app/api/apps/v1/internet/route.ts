import { NextRequest, NextResponse } from "next/server";
import { lookup } from "dns/promises";
import { isIP } from "net";
import { validateAppToken } from "@/lib/auth/app-token";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getApp } from "@/lib/db/queries/app-management";
import { checkPermission } from "@/lib/db/queries/permissions";
import { findInternetScope, permissionForInternetHost } from "@/lib/internet/scopes";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "cookie",
]);

function normalizeAppId(appId: string): string {
  return appId.replace(/^ye-/, "").replace(/^app-/, "");
}

function parseTargetUrl(request: NextRequest): URL | null {
  const raw = request.nextUrl.searchParams.get("url");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function isBlockedIp(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe80:");
  }
  const [a, b] = address.split(".").map((part) => Number(part));
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

async function assertPublicHost(hostname: string): Promise<boolean> {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".youeye")) return false;
  try {
    const records = await lookup(hostname, { all: true });
    return records.length > 0 && records.every((record) => !isBlockedIp(record.address));
  } catch {
    return false;
  }
}

function copyRequestHeaders(request: NextRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase().startsWith("x-youeye-")) continue;
    headers.set(key, value);
  }
  return headers;
}

// fetch() decompresses upstream bodies but leaves the original
// content-encoding/content-length headers in place; forwarding them makes
// compliant clients inflate plain bytes (Z_DATA_ERROR).
const DECODED_BODY_HEADERS = new Set(["content-encoding", "content-length"]);

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(name)) return;
    if (DECODED_BODY_HEADERS.has(name)) return;
    headers.set(key, value);
  });
  return headers;
}

async function proxy(request: NextRequest) {
  const rawAppId = request.headers.get("x-youeye-app");
  if (!rawAppId) {
    return NextResponse.json({ error: "Missing X-YouEye-App header" }, { status: 401 });
  }

  const tokenResult = await validateAppToken(request);
  if (!tokenResult) {
    return NextResponse.json({ error: "Invalid or missing app token" }, { status: 401 });
  }

  const sourceAppId = normalizeAppId(rawAppId);
  if (normalizeAppId(tokenResult.appId) !== sourceAppId) {
    return NextResponse.json({ error: "App token does not match X-YouEye-App" }, { status: 403 });
  }

  const targetUrl = parseTargetUrl(request);
  if (!targetUrl) {
    return NextResponse.json({ error: "A valid https url query parameter is required" }, { status: 400 });
  }

  const app = await getApp(sourceAppId);
  if (!app) {
    return NextResponse.json({ error: `App "${rawAppId}" not registered` }, { status: 403 });
  }

  const manifest = (app.manifest as Record<string, unknown> | null) ?? null;
  const scope = findInternetScope(manifest, targetUrl, request.method);
  if (!scope) {
    return NextResponse.json({ error: `Internet target is not declared for ${sourceAppId}` }, { status: 403 });
  }

  if (!(await assertPublicHost(targetUrl.hostname))) {
    return NextResponse.json({ error: "Internet proxy target is not public" }, { status: 403 });
  }

  const serviceUser = await resolveServiceAuth(request);
  if (scope.scope === "user") {
    if (!serviceUser) {
      return NextResponse.json({ error: "Internet proxy requires current user identity" }, { status: 401 });
    }
    const granted = await checkPermission(serviceUser.id, sourceAppId, permissionForInternetHost(scope.host));
    if (!granted) {
      return NextResponse.json({ error: `Internet access to ${scope.host} is not allowed for this user` }, { status: 403 });
    }
  }

  const init: RequestInit = {
    method: request.method,
    headers: copyRequestHeaders(request),
    redirect: "manual",
    cache: "no-store",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(targetUrl, init);
  const location = upstream.headers.get("location");
  if (location && upstream.status >= 300 && upstream.status < 400) {
    try {
      const redirectUrl = new URL(location, targetUrl);
      const redirectScope = findInternetScope(manifest, redirectUrl, request.method);
      if (!redirectScope || redirectScope.host !== scope.host || !(await assertPublicHost(redirectUrl.hostname))) {
        return NextResponse.json({ error: "Upstream redirect leaves allowed internet scope" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Invalid upstream redirect" }, { status: 502 });
    }
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream),
  });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const HEAD = proxy;
