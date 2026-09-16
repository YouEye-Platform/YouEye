import { isApplianceSetupHost } from '../auth/mode';

/** Accept the identity origin itself or the direct HTTPS appliance setup surface. */
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
  return parsed.protocol === 'https:' && isApplianceSetupHost(parsed.host);
}
