/**
 * OAuth2 Client
 *
 * Handles the OAuth2 Authorization Code flow for SSO login.
 * YouEye-UI supports YouEye ID first. Authentik env names remain temporary
 * compatibility aliases during the migration.
 *
 * Flow:
 * 1. User visits https://yourdomain.com
 * 2. Middleware redirects unauthenticated user to /login
 * 3. Login page redirects to /api/auth/sso → Authentik authorize URL
 * 4. User authenticates in Authentik
 * 5. Authentik redirects back to /api/auth/callback with code
 * 6. We exchange code for tokens, extract user info, create JWT session
 *
 * Environment Variables Required:
 * - YOUEYE_ID_URL: External YouEye ID URL
 * - YOUEYE_ID_INTERNAL_URL: Internal/proxy URL for token/userinfo calls
 * - YOUEYE_ID_CLIENT_ID: OAuth2 client ID
 * - YOUEYE_ID_CLIENT_SECRET: OAuth2 client secret
 */

/** OAuth2 configuration from environment variables */
export function getOAuthConfig() {
  const clientId = process.env.YOUEYE_ID_CLIENT_ID || process.env.AUTHENTIK_CLIENT_ID || "";
  const clientSecret = process.env.YOUEYE_ID_CLIENT_SECRET || process.env.AUTHENTIK_CLIENT_SECRET || "";
  const identityUrl = process.env.YOUEYE_ID_URL || process.env.AUTHENTIK_URL || "";
  // Internal URL for server→server calls (bypasses TLS/self-signed cert issues)
  const internalUrl = process.env.YOUEYE_ID_INTERNAL_URL || process.env.AUTHENTIK_INTERNAL_URL || identityUrl;

  return {
    clientId,
    clientSecret,
    identityUrl,
    authorizeUrl: `${identityUrl}/application/o/authorize/`,
    tokenUrl: `${internalUrl}/application/o/token/`,
    userinfoUrl: `${internalUrl}/application/o/userinfo/`,
  };
}

/** Build the OAuth2 authorization redirect URL */
export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: "openid profile email groups",
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/** Exchange authorization code for access token */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<{ access_token: string; id_token?: string; token_type: string }> {
  const config = getOAuthConfig();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

/** Fetch user profile from Authentik userinfo endpoint */
export async function fetchUserInfo(accessToken: string): Promise<{
  sub: string;
  preferred_username: string;
  name: string;
  given_name?: string;
  family_name?: string;
  email: string;
  groups: string[];
}> {
  const config = getOAuthConfig();

  const res = await fetch(config.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Userinfo fetch failed (${res.status}): ${text}`);
  }

  return res.json();
}

/** Generate a cryptographically random state parameter for CSRF protection */
export function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Check if SSO is configured (required env vars are present) */
export function isSSOConfigured(): boolean {
  const config = getOAuthConfig();
  return !!(config.identityUrl && config.clientId && config.clientSecret);
}
