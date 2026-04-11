/**
 * Authentik OAuth2 Helper
 *
 * Handles the OAuth2 Authorization Code flow for SSO login
 * when the Control Panel is accessed via subdomain (through Caddy).
 *
 * Flow:
 * 1. User visits control.youeye.local (subdomain → Caddy → CP)
 * 2. Middleware redirects to /api/auth/sso which redirects to Authentik authorize URL
 * 3. User authenticates in Authentik
 * 4. Authentik redirects back to /api/auth/callback with code
 * 5. We exchange code for tokens, extract user info, create JWT session
 */

/**
 * Get OAuth2 configuration from environment.
 * These values must be provisioned by Spine when setting up Authentik.
 */
export function getOAuthConfig() {
  const clientId = process.env.AUTHENTIK_CLIENT_ID || 'youeye-control';
  const clientSecret = process.env.AUTHENTIK_CLIENT_SECRET || '';
  const authentikUrl = process.env.AUTHENTIK_URL || '';
  // Internal URL is used for server-side calls (token exchange, userinfo)
  // to avoid TLS issues with self-signed certs from Caddy
  const internalUrl = process.env.AUTHENTIK_INTERNAL_URL || authentikUrl;

  return {
    clientId,
    clientSecret,
    authentikUrl,
    authorizeUrl: `${authentikUrl}/application/o/authorize/`,
    tokenUrl: `${internalUrl}/application/o/token/`,
    userinfoUrl: `${internalUrl}/application/o/userinfo/`,
  };
}

/**
 * Build the OAuth2 authorization URL for redirect
 */
export function buildAuthorizeUrl(redirectUri: string, state: string): string {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: 'openid profile email groups',
    state,
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
): Promise<{ access_token: string; id_token?: string; token_type: string }> {
  const config = getOAuthConfig();

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });

  const res = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Fetch user info from the access token
 */
export async function fetchUserInfo(
  accessToken: string,
): Promise<{
  sub: string;
  preferred_username: string;
  name: string;
  email: string;
  groups: string[];
}> {
  const config = getOAuthConfig();

  const res = await fetch(config.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Userinfo fetch failed (${res.status}): ${text}`);
  }

  return res.json();
}

/**
 * Generate a random state parameter for CSRF protection in OAuth2 flow
 */
export function generateOAuthState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Determine if OAuth/SSO is configured (has the required env vars)
 */
export function isSSOConfigured(): boolean {
  return !!(process.env.AUTHENTIK_URL && process.env.AUTHENTIK_CLIENT_SECRET);
}
