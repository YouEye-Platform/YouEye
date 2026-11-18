/**
 * What the local setup surface (box IP or `youeye.local`, over HTTP or HTTPS) serves. It is onboarding only:
 * claim and setup before setup completes; afterwards just the setup-complete hand-off and the owner password
 * reset. Never YouEye ID sign-in, Settings, the dashboard or apps. Dependency-free (used by the proxy).
 *
 * An entry ending in `/` is a prefix; any other entry matches itself and the paths below it.
 */

const BEFORE_SETUP = [
  '/setup', '/setup-complete', '/login', '/api/ping',
  '/reset-owner', '/settings/reset-owner', '/settings/api/auth/reset-owner',
  '/api/auth/', '/api/setup/', '/api/deploy/', '/api/tls/',
  '/api/appliance/',
  '/api/dns-providers/cloudflare/validate',
  '/api/branding/favicon',
];

/** Read-only paths the setup-complete page and a finishing wizard use. */
const AFTER_SETUP_READ = [
  '/setup-complete', '/api/ping', '/api/auth/csrf',
  // SetupDnsExplainer: the address, the certificate and its fingerprint, the device profiles.
  '/api/setup/config', '/api/setup/server-address', '/api/setup/ca-cert', '/api/setup/ca-fingerprint', '/api/setup/profile',
  // A wizard that lost its progress stream reads retained status across the Control Panel restart.
  '/api/setup/status',
  '/api/branding/favicon',
  '/reset-owner', '/settings/reset-owner',
];

const AFTER_SETUP_WRITE = [
  // "Continue to your server": the one-time hand-off to YouEye ID on the platform domain.
  '/api/appliance/handoff',
  // Owner password reset with the code on the box's console.
  '/settings/api/auth/reset-owner', '/api/auth/reset-owner',
  // The "upload a certificate" choice installs it after provisioning marked setup complete.
  '/api/tls/upload',
];

function matches(pathname: string, entries: string[]): boolean {
  return entries.some((entry) => entry.endsWith('/')
    ? pathname.startsWith(entry)
    : pathname === entry || pathname.startsWith(`${entry}/`));
}

export function setupHostAllows(pathname: string, method: string, setupCompleted: boolean): boolean {
  if (!setupCompleted) return matches(pathname, BEFORE_SETUP);
  const read = method === 'GET' || method === 'HEAD';
  return (read && matches(pathname, AFTER_SETUP_READ)) || matches(pathname, AFTER_SETUP_WRITE);
}

/** Password sign-in paths: never accepted over plain HTTP on the setup surface. */
export function isPasswordSignInPath(pathname: string): boolean {
  return pathname === '/api/auth/login' || pathname === '/settings/api/auth/login';
}

/** The scheme Caddy reports for the request (`x-forwarded-proto`), else the request URL's. */
export function requestIsPlainHttp(forwardedProto: string | null, url: string): boolean {
  const forwarded = forwardedProto?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'http';
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}
