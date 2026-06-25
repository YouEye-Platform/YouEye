import { getIdentityConfig } from './config';
import { getAppBridgeGatewayIP } from '@/lib/incus/app-network';

const APP_CLIENT_PREFIX = 'youeye-app-';

/**
 * Internal identity back-channel base for an APP client: `http://<app-gw>:3002`,
 * the per-app-bridge identity DNAT (`<app-gw>:3002 → youeye-control:3001`). It is
 * domain-free, CA-free, and survives full network isolation (the DNAT is a separate
 * incus object from the bridge `ipv4.nat`).
 *
 * Returns `null` for first-party clients (`youeye-control` / `youeye-ui`, which are
 * browser-based and lenient) and when the app's bridge gateway can't be resolved —
 * the caller then falls back to the external identity URL (works for non-isolated apps).
 */
export async function getAppInternalIdentityBase(clientId: string): Promise<string | null> {
  if (!clientId.startsWith(APP_CLIENT_PREFIX)) return null;
  const appId = clientId.slice(APP_CLIENT_PREFIX.length);
  const gateway = await getAppBridgeGatewayIP(appId);
  if (!gateway) return null;
  return `http://${gateway}:3002`;
}

/**
 * The issuer string for a client — identical to what the per-client discovery doc
 * advertises and to the id_token `iss`. For app clients it is the clientId-derived
 * INTERNAL authority (`http://<app-gw>:3002/application/o/<clientId>/`); for everyone
 * else (and on resolution failure) the external identity URL.
 *
 * The discovery route and token issuance MUST call this with the same clientId so a
 * strict client validating `iss === discovered issuer` passes — even under isolation
 * (OIDC Discovery §4.3 / RFC 8414 §3.3 require iss == the discovery-doc URL prefix).
 */
export async function getClientIssuer(clientId: string): Promise<string> {
  const base = await getAppInternalIdentityBase(clientId);
  if (base) return `${base}/application/o/${clientId}/`;
  const config = await getIdentityConfig();
  return `${config.externalUrl}/application/o/${clientId}/`;
}
