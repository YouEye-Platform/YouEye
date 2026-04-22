/**
 * Auth Providers — Admin API
 *
 * GET  /api/settings/auth-providers — List all providers (with user token status)
 * POST /api/settings/auth-providers — Create a new provider (admin only)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  listProviders,
  createProvider,
  getUserToken,
  isTokenExpired,
} from "@/lib/db/queries/auth-providers";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = await listProviders();

  // For each provider, check if the current user has a token
  const result = await Promise.all(
    providers.map(async (p) => {
      const token = await getUserToken(session.userId, p.id);
      return {
        id: p.id,
        slug: p.slug,
        name: p.name,
        type: p.type,
        enabled: p.enabled,
        hasClientId: !!p.clientId,
        authUrl: p.authUrl,
        defaultScopes: p.defaultScopes,
        userConnected: !!token,
        userTokenExpired: token ? isTokenExpired(token.expiresAt) : false,
      };
    })
  );

  return NextResponse.json({ providers: result });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const body = await request.json();
  const { slug, name, type, clientId, clientSecret, authUrl, tokenUrl, defaultScopes, config } = body;

  if (!slug || !name || !type) {
    return NextResponse.json({ error: "Missing slug, name, or type" }, { status: 400 });
  }

  try {
    const provider = await createProvider({
      slug,
      name,
      type,
      clientId,
      clientSecret,
      authUrl,
      tokenUrl,
      defaultScopes,
      config,
    });

    return NextResponse.json({ provider: { id: provider.id, slug: provider.slug } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create provider";
    if (msg.includes("unique constraint")) {
      return NextResponse.json({ error: `Provider "${slug}" already exists` }, { status: 409 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
