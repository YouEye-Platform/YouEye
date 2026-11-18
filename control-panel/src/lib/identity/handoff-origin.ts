import { isLocalSetupHost } from '../auth/mode';

/**
 * Accept the identity origin itself or the box's local setup surface (`<ip>` or `youeye.local`), over HTTPS or
 * HTTP: onboarding works over plain HTTP on the LAN, and the handoff code is single-use and short-lived.
 */
export function isTrustedHandoffBrowserOrigin(browserOrigin: string | null, expectedOrigin: string): boolean {
  if (!browserOrigin) return true;

  let parsed: URL;
  try {
    parsed = new URL(browserOrigin);
  } catch {
    return false;
  }

  if (browserOrigin !== parsed.origin) return false;
  if (parsed.origin === expectedOrigin) return true;
  return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && isLocalSetupHost(parsed.host);
}
