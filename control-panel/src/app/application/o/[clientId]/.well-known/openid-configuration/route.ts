import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient } from '@/lib/identity/store';
import { getAppInternalIdentityBase } from '@/lib/identity/issuer';

// Per-client OIDC discovery, SPLIT BY CHANNEL.
//   - Back-channel (issuer / token / userinfo / jwks): the app's INTERNAL identity
//     DNAT `http://<app-gw>:3002` — domain-free, CA-free, and reachable under full
//     network isolation. For app clients this base is clientId-derived
//     (getAppBridgeGatewayIP), so it equals the URL the app fetched this document
//     from, satisfying the RFC 8414 §3.3 / OIDC Discovery §4.3 rule that `issuer`
//     equal the discovery-doc URL prefix. The same value is set as the id_token `iss`
//     (see identity/issuer.ts → tokens.ts) so strict clients (the Rust openidconnect
//     crate, Spring Security, go-oidc) accept the token, even when isolated.
//   - Front-channel (authorize / end_session): always EXTERNAL — the browser reaches
//     the public identity domain via Caddy.
// First-party clients (youeye-control / youeye-ui) and any app whose bridge gateway
// can't be resolved fall back to the external base (lenient / non-isolated).
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const { clientId } = await params;
  const client = await getClient(clientId);
  if (!client) {
    return NextResponse.json({ error: 'unknown_client' }, { status: 404 });
  }
  const config = await getIdentityConfig();
  const internalBase = await getAppInternalIdentityBase(clientId);
  const backChannel = internalBase || config.externalUrl;
  return NextResponse.json({
    issuer: `${backChannel}/application/o/${clientId}/`,
    authorization_endpoint: `${config.externalUrl}/application/o/authorize/`,
    end_session_endpoint: `${config.externalUrl}/application/o/${clientId}/end-session/`,
    token_endpoint: `${backChannel}/application/o/token`,
    userinfo_endpoint: `${backChannel}/application/o/userinfo`,
    jwks_uri: `${backChannel}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups', 'immich_role'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
}
