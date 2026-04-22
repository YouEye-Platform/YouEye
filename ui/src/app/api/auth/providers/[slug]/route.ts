/**
 * GET /api/auth/providers/[slug] — Start OAuth2 flow
 *
 * Redirects the user to the provider's authorization URL.
 * Query params:
 *   - scopes: additional scopes (space-separated, appended to provider defaults)
 *   - redirect_uri: where to go after callback (defaults to /settings/connectors)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getProvider } from "@/lib/db/queries/auth-providers";
import crypto from "node:crypto";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const provider = await getProvider(slug);

  if (!provider || !provider.enabled) {
    return NextResponse.json({ error: "Provider not found or disabled" }, { status: 404 });
  }

  if (provider.type !== "oauth2" || !provider.authUrl || !provider.clientId) {
    return NextResponse.json({ error: "Provider is not OAuth2 or missing config" }, { status: 400 });
  }

  const url = new URL(request.url);
  const extraScopes = url.searchParams.get("scopes") ?? "";
  const redirectAfter = url.searchParams.get("redirect_uri") ?? "/settings/connectors";

  // Build scopes — provider defaults + any extra requested
  const scopes = new Set<string>();
  if (provider.defaultScopes) {
    provider.defaultScopes.split(" ").forEach((s) => scopes.add(s));
  }
  if (extraScopes) {
    extraScopes.split(" ").forEach((s) => scopes.add(s));
  }

  // Generate state token (CSRF protection)
  const state = crypto.randomBytes(32).toString("hex");
  // Store state + metadata in a short-lived cookie
  const stateData = JSON.stringify({
    state,
    userId: session.userId,
    providerId: provider.id,
    redirectAfter,
  });

  const uiBase = process.env.UI_EXTERNAL_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  const callbackUrl = `${uiBase}/api/auth/providers/${slug}/callback`;

  // Build authorization URL
  const authUrl = new URL(provider.authUrl);
  authUrl.searchParams.set("client_id", provider.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", callbackUrl);
  authUrl.searchParams.set("scope", Array.from(scopes).join(" "));
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("access_type", "offline"); // request refresh token

  // PKCE if configured
  const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
  if (providerConfig.pkce) {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    // Store verifier in state cookie for callback
    const stateWithPKCE = JSON.parse(stateData);
    stateWithPKCE.codeVerifier = verifier;

    const response = NextResponse.redirect(authUrl.toString());
    response.cookies.set("youeye_oauth_state", JSON.stringify(stateWithPKCE), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600, // 10 minutes
      path: "/",
    });
    return response;
  }

  const response = NextResponse.redirect(authUrl.toString());
  response.cookies.set("youeye_oauth_state", stateData, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/",
  });
  return response;
}
