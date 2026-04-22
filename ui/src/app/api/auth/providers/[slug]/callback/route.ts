/**
 * GET /api/auth/providers/[slug]/callback — OAuth2 callback
 *
 * Exchanges the authorization code for tokens, stores them encrypted,
 * propagates credentials to linked connectors, and redirects back.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getProvider,
  saveUserToken,
  propagateProviderCredentials,
} from "@/lib/db/queries/auth-providers";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Retrieve state from cookie
  const stateCookie = request.cookies.get("youeye_oauth_state")?.value;
  if (!stateCookie) {
    return NextResponse.json({ error: "Missing OAuth state cookie" }, { status: 400 });
  }

  let stateData: {
    state: string;
    userId: string;
    providerId: string;
    redirectAfter: string;
    codeVerifier?: string;
  };

  try {
    stateData = JSON.parse(stateCookie);
  } catch {
    return NextResponse.json({ error: "Invalid state cookie" }, { status: 400 });
  }

  // Validate CSRF state
  if (state !== stateData.state) {
    return NextResponse.json({ error: "State mismatch (CSRF)" }, { status: 400 });
  }

  if (error) {
    const desc = url.searchParams.get("error_description") ?? error;
    const redirectUrl = new URL(stateData.redirectAfter, request.url);
    redirectUrl.searchParams.set("auth_error", desc);
    const response = NextResponse.redirect(redirectUrl.toString());
    response.cookies.delete("youeye_oauth_state");
    return response;
  }

  if (!code) {
    return NextResponse.json({ error: "Missing authorization code" }, { status: 400 });
  }

  const provider = await getProvider(slug);
  if (!provider || !provider.tokenUrl || !provider.clientId) {
    return NextResponse.json({ error: "Provider misconfigured" }, { status: 500 });
  }

  // Decrypt client secret
  let clientSecret = "";
  if (provider.clientSecretEncrypted && provider.clientSecretNonce) {
    try {
      const crypto = await import("node:crypto");
      const ENCRYPTION_KEY = process.env.CONNECTOR_ENCRYPTION_KEY || "youeye-dev-key-32bytes-padding!";
      const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "!").slice(0, 32));
      const iv = Buffer.from(provider.clientSecretNonce, "base64");
      const data = Buffer.from(provider.clientSecretEncrypted, "base64");
      const authTag = data.subarray(data.length - 16);
      const ciphertext = data.subarray(0, data.length - 16);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      clientSecret = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
    } catch {
      return NextResponse.json({ error: "Failed to decrypt client secret" }, { status: 500 });
    }
  }

  // Exchange code for tokens
  const uiBase = process.env.UI_EXTERNAL_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";
  const callbackUrl = `${uiBase}/api/auth/providers/${slug}/callback`;

  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: callbackUrl,
    client_id: provider.clientId,
    client_secret: clientSecret,
  };

  if (stateData.codeVerifier) {
    tokenParams.code_verifier = stateData.codeVerifier;
  }

  try {
    const tokenRes = await fetch(provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenParams),
      signal: AbortSignal.timeout(15_000),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error(`[auth-providers] Token exchange failed for ${slug}:`, errBody);
      const redirectUrl = new URL(stateData.redirectAfter, request.url);
      redirectUrl.searchParams.set("auth_error", "Token exchange failed");
      const response = NextResponse.redirect(redirectUrl.toString());
      response.cookies.delete("youeye_oauth_state");
      return response;
    }

    const tokenData = await tokenRes.json();
    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : null;

    // Derive bound hosts from provider's known hosts
    const providerConfig = (provider.config ?? {}) as Record<string, unknown>;
    const boundHosts = (providerConfig.boundHosts as string) ?? undefined;

    // Store tokens
    await saveUserToken(stateData.userId, stateData.providerId, {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      scopes: tokenData.scope,
      expiresAt,
      boundHosts,
    });

    // Propagate to linked connector secrets
    const propagated = await propagateProviderCredentials(
      stateData.userId,
      stateData.providerId,
      tokenData.access_token,
      boundHosts
    );

    console.log(`[auth-providers] ${slug}: token saved for user ${stateData.userId}, propagated to ${propagated} connector secrets`);

    // Redirect back
    const redirectUrl = new URL(stateData.redirectAfter, request.url);
    redirectUrl.searchParams.set("auth_success", slug);
    const response = NextResponse.redirect(redirectUrl.toString());
    response.cookies.delete("youeye_oauth_state");
    return response;
  } catch (err) {
    console.error(`[auth-providers] Token exchange error for ${slug}:`, err);
    const redirectUrl = new URL(stateData.redirectAfter, request.url);
    redirectUrl.searchParams.set("auth_error", "Network error during token exchange");
    const response = NextResponse.redirect(redirectUrl.toString());
    response.cookies.delete("youeye_oauth_state");
    return response;
  }
}
