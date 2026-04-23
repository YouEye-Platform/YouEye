/**
 * Discovery API — GET /api/v1/my-connections
 *
 * Apps call this to learn what they're connected to.
 * Auth: X-YouEye-App header identifies the calling app.
 *
 * Returns:
 *   - bridges: active bridge connections for this app
 *   - internet: internet access status
 *   - available: wanted apps (from manifest) with install status
 */

import { NextResponse } from "next/server";

const CP_URL =
  process.env.CP_INTERNAL_URL || "http://youeye-control.youeye:3000";

let _cache: Map<string, { data: unknown; ts: number }> = new Map();
const CACHE_TTL = 30_000; // 30s

interface Bridge {
  appId: string;
  name: string;
  host: string;
  port: number;
  direction: string;
}

interface InternetStatus {
  granted: boolean;
  hosts: string[];
  blanket: boolean;
}

interface AvailableBackend {
  appId: string;
  name: string;
  installed: boolean;
}

export async function GET(request: Request) {
  const appSlug = request.headers.get("X-YouEye-App") ??
    request.headers.get("x-youeye-app");

  if (!appSlug) {
    return NextResponse.json(
      { error: "X-YouEye-App header required" },
      { status: 401 },
    );
  }

  // Check cache
  const cacheKey = `connections:${appSlug}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    // Fetch bridges for this app from CP
    const [bridgesRes, internetRes] = await Promise.all([
      fetch(`${CP_URL}/api/bridges?appId=${appSlug}`),
      fetch(`${CP_URL}/api/internet-grants?appId=${appSlug}`),
    ]);

    const bridgesData = bridgesRes.ok ? await bridgesRes.json() : [];
    const internetData = internetRes.ok ? await internetRes.json() : [];

    // Map bridges to connection format
    const bridges: Bridge[] = (Array.isArray(bridgesData) ? bridgesData : [])
      .filter((b: Record<string, unknown>) => b.active)
      .map((b: Record<string, unknown>) => ({
        appId: b.to as string,
        name: b.to as string,
        host: `app-${b.to}-main.youeye`,
        port: 3000,
        direction: b.direction as string || "one-way",
      }));

    // Internet status
    const grant = Array.isArray(internetData) ? internetData[0] : null;
    const internet: InternetStatus = grant
      ? {
          granted: true,
          hosts: (grant.hosts as string[]) || [],
          blanket: (grant.blanket as boolean) || false,
        }
      : { granted: false, hosts: [], blanket: false };

    // Fetch available backends (from manifest wants)
    let available: AvailableBackend[] = [];
    try {
      const suggestionsRes = await fetch(`${CP_URL}/api/suggestions`);
      if (suggestionsRes.ok) {
        const suggestions = await suggestionsRes.json();
        available = (Array.isArray(suggestions) ? suggestions : [])
          .filter((s: Record<string, unknown>) =>
            s.fromAppId === appSlug && s.type === "bridge" && !s.dismissed
          )
          .map((s: Record<string, unknown>) => ({
            appId: s.targetAppId as string,
            name: s.targetAppName as string,
            installed: (s.targetInstalled as boolean) || false,
          }));
      }
    } catch {
      // Suggestions not critical
    }

    const result = { bridges, internet, available };
    _cache.set(cacheKey, { data: result, ts: Date.now() });

    return NextResponse.json(result);
  } catch (err) {
    console.error("[my-connections] Error:", err);
    return NextResponse.json(
      { bridges: [], internet: { granted: false, hosts: [], blanket: false }, available: [] },
    );
  }
}
