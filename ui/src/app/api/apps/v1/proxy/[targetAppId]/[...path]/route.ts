import { NextRequest, NextResponse } from "next/server";
import { db, ensureSchema } from "@/db";
import { apps } from "@/db/schema";
import { validateAppToken } from "@/lib/auth/app-token";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type Connection = {
  appId?: string;
  host?: string;
  port?: number;
  url?: string;
  accessMode?: string;
  allowedPaths?: string[];
  allowedMethods?: string[];
  active?: boolean;
};

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
]);

function normalizeAppId(appId: string): string {
  return appId.replace(/^ye-/, "").replace(/^app-/, "");
}

function appMatches(left: string | undefined, right: string): boolean {
  if (!left) return false;
  return normalizeAppId(left) === normalizeAppId(right);
}

function pathMatches(pattern: string, path: string): boolean {
  if (pattern === "*" || pattern === "/*") return true;
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

function allowedByPath(connection: Connection, path: string): boolean {
  const patterns = connection.allowedPaths;
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => pathMatches(pattern, path));
}

function allowedByMethod(connection: Connection, method: string): boolean {
  const methods = connection.allowedMethods;
  if (!methods || methods.length === 0) return true;
  return methods.some((allowed) => allowed.toUpperCase() === method.toUpperCase());
}

function upstreamBase(connection: Connection): string | null {
  if (connection.url) return connection.url.replace(/\/$/, "");
  if (connection.host && connection.port) return `http://${connection.host}:${connection.port}`;
  return null;
}

function copyRequestHeaders(request: NextRequest, token: string | null): Headers {
  const headers = new Headers();
  for (const [key, value] of request.headers) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (key.toLowerCase() === "authorization") continue;
    headers.set(key, value);
  }

  const appId = request.headers.get("x-youeye-app") || "";
  if (appId) headers.set("X-YouEye-App", appId);
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
    headers.set("X-YouEye-App-Token", token);
  }
  return headers;
}

function copyResponseHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  return headers;
}

async function proxy(request: NextRequest, context: { params: Promise<{ targetAppId: string; path?: string[] }> }) {
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

  const { targetAppId, path = [] } = await context.params;
  const targetPath = `/${path.join("/")}`;

  await ensureSchema();
  let rows = await db
    .select({ id: apps.id, connections: apps.connections })
    .from(apps)
    .where(eq(apps.id, sourceAppId))
    .limit(1);

  if (rows.length === 0 && sourceAppId !== rawAppId) {
    rows = await db
      .select({ id: apps.id, connections: apps.connections })
      .from(apps)
      .where(eq(apps.id, rawAppId))
      .limit(1);
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: `App "${rawAppId}" not registered` }, { status: 403 });
  }

  const connData = rows[0].connections as Record<string, unknown> | null;
  const bridges = ((connData?.bridges as unknown[]) ?? []) as Connection[];
  const connection = bridges.find((bridge) => bridge.active !== false && appMatches(bridge.appId, targetAppId));
  if (!connection) {
    return NextResponse.json({ error: `Connection to "${targetAppId}" is not approved or active` }, { status: 403 });
  }

  if (!allowedByMethod(connection, request.method)) {
    return NextResponse.json({ error: `Method ${request.method} is not allowed for this connection` }, { status: 403 });
  }
  if (!allowedByPath(connection, targetPath)) {
    return NextResponse.json({ error: `Path ${targetPath} is not allowed for this connection` }, { status: 403 });
  }

  const base = upstreamBase(connection);
  if (!base) {
    return NextResponse.json({ error: `Connection to "${targetAppId}" has no proxy target` }, { status: 502 });
  }

  const upstreamUrl = `${base}${targetPath}${request.nextUrl.search}`;
  const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const init: RequestInit = {
    method: request.method,
    headers: copyRequestHeaders(request, bearer),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const upstream = await fetch(upstreamUrl, init);
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
