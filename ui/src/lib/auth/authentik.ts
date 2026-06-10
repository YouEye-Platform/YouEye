/**
 * OAuth2 Client
 *
 * Handles the OAuth2 Authorization Code flow for SSO login.
 * YouEye UI uses the configured white-label identity provider.
 *
 * Flow:
 * 1. User visits https://yourdomain.com
 * 2. Middleware redirects unauthenticated user to /login
 * 3. Login page redirects to /api/auth/sso → identity authorize URL
 * 4. User authenticates with the identity provider
 * 5. The identity provider redirects back to /api/auth/callback with code
 * 6. We exchange code for tokens, extract user info, create JWT session
 *
 * Environment Variables Required:
 * - IDENTITY_URL: External identity URL
 * - IDENTITY_INTERNAL_URL: Internal/proxy URL for token/userinfo calls
 * - IDENTITY_CLIENT_ID: OAuth2 client ID
 * - IDENTITY_CLIENT_SECRET: OAuth2 client secret
 */

/** OAuth2 configuration from environment variables */
export function getOAuthConfig() {
  const clientId = process.env.IDENTITY_CLIENT_ID || "";
  const clientSecret = process.env.IDENTITY_CLIENT_SECRET || "";
  const identityUrl = process.env.IDENTITY_URL || "";
  // Internal URL for server→server calls (bypasses TLS/self-signed cert issues)
  const internalUrl = process.env.IDENTITY_INTERNAL_URL || identityUrl;

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

/** Fetch user profile from the identity userinfo endpoint */
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
