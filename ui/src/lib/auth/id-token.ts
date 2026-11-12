import { createRemoteJWKSet, jwtVerify } from "jose";

type IdentityDiscovery = { issuer?: string; jwks_uri?: string };

export async function verifyIdentityToken(
  token: string,
  discovery: IdentityDiscovery,
  clientId: string,
  internalIdentityUrl: string,
) {
  if (!discovery.issuer || !discovery.jwks_uri) {
    throw new Error("Identity discovery is incomplete");
  }

  // First-party discovery advertises the browser-facing JWKS URL. Use the
  // configured internal provider for transport, while checking the advertised
  // endpoint and retaining the provider's issuer for token validation.
  const advertisedKeys = new URL(discovery.jwks_uri);
  if (advertisedKeys.pathname !== "/oauth/jwks" || advertisedKeys.search || advertisedKeys.hash) {
    throw new Error("Identity discovery has an unexpected JWKS endpoint");
  }
  const internalKeys = new URL("/oauth/jwks", `${internalIdentityUrl}/`);
  const keys = createRemoteJWKSet(internalKeys);
  return jwtVerify(token, keys, { issuer: discovery.issuer, audience: clientId });
}
