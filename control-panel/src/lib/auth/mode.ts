import { isSSOConfigured } from './oauth';
import { isMdnsSetupName } from './setup-names';

export type AuthMode = 'pam' | 'sso';

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

function hostnameOf(url: string | undefined, dropFirstLabel: boolean): string | null {
  if (!url) return null;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    if (!dropFirstLabel) return hostname;
    const labels = hostname.split('.');
    return labels.length >= 3 ? labels.slice(1).join('.') : null;
  } catch {
    return null;
  }
}

/** The configured platform domain(s), from the URLs Spine and setup give the Control Panel. */
function configuredPlatformDomains(): string[] {
  return [
    hostnameOf(process.env.UI_EXTERNAL_URL, false),
    hostnameOf(process.env.CONTROL_EXTERNAL_URL, true),
    hostnameOf(process.env.CONTROL_PUBLIC_URL, true),
    hostnameOf(process.env.IDENTITY_URL, true),
  ].filter((domain): domain is string => !!domain);
}

function isPlatformHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return configuredPlatformDomains().some((domain) => lower === domain || lower.endsWith(`.${domain}`));
}

/**
 * The box's onboarding surface: the box IP or exactly the mDNS name Avahi publishes (`youeye.local`, or
 * `youeye-<N>.local` after a conflict) through Caddy, on any port except the raw Control Panel port 3000
 * (localhost-only recovery). The configured platform domain and its subdomains never are, whatever their name.
 * Claim, setup, setup-complete and reset-owner run only here; YouEye ID sign-in, Settings and apps never do.
 */
export function isLocalSetupHost(host: string): boolean {
  const match = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(host.trim());
  if (!match) return false;
  const [, hostname, port] = match;
  if (port === '3000') return false;
  if (!IPV4_LITERAL.test(hostname) && !isMdnsSetupName(hostname)) return false;
  return !isPlatformHostname(hostname);
}

/** `localhost` or `127.0.0.1` on any port: the raw-port recovery path. */
export function isLoopbackHost(host: string): boolean {
  const hostname = host.trim().replace(/:\d{1,5}$/, '');
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/** Hosts where the box's own password sign-in (PAM) is used instead of YouEye ID SSO. */
export function isPasswordSignInHost(host: string): boolean {
  return isLocalSetupHost(host) || isLoopbackHost(host);
}

export function getAuthModeForHost(host: string): AuthMode {
  return isPasswordSignInHost(host) || !isSSOConfigured() ? 'pam' : 'sso';
}

type CookieRequest = { headers: { get(name: string): string | null }; url?: string };

/**
 * Whether a cookie set in answer to `request` gets `Secure`. Named hosts always do (SECURE_COOKIES); on a local
 * setup host (or the loopback recovery port) it follows the scheme Caddy reports in X-Forwarded-Proto, so setup over
 * `http://youeye.local` or `http://<ip>` keeps its session. `SECURE_COOKIES=false` (development) turns it off.
 */
export function secureCookieFor(request?: CookieRequest | null): boolean {
  if (process.env.SECURE_COOKIES === 'false') return false;
  if (!request) return true;
  const host = request.headers.get('host') || '';
  if (!isPasswordSignInHost(host)) return true;
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded !== 'http';
  try {
    return new URL(request.url ?? '').protocol !== 'http:';
  } catch {
    return true;
  }
}
