import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient } from '@/lib/identity/store';
import { getAppInternalIdentityBase, getClientIssuer } from '@/lib/identity/issuer';

// Per-client OIDC discovery, SPLIT BY CHANNEL.
//   - Back-channel (issuer / token / userinfo / jwks): managed apps use logical
//     id.youeye:3002, resolved on each isolated bridge to its current gateway.
//   - Front-channel (authorize / end_session): always EXTERNAL — the browser reaches
//     the public identity domain via Caddy.
// First-party clients (youeye-control / youeye-ui) use the external base.
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
    issuer: await getClientIssuer(clientId),
    authorization_endpoint: `${config.externalUrl}/application/o/authorize/`,
    end_session_endpoint: `${config.externalUrl}/application/o/${clientId}/end-session/`,
    revocation_endpoint: `${backChannel}/application/o/revoke`,
    ...(client.backchannel_logout_uri ? {
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    } : {}),
    token_endpoint: `${backChannel}/application/o/token`,
    userinfo_endpoint: `${backChannel}/application/o/userinfo`,
    jwks_uri: `${backChannel}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups', 'immich_role'],
    token_endpoint_auth_methods_supported: client.client_secret
      ? ['client_secret_basic', 'client_secret_post'] : ['none'],
    revocation_endpoint_auth_methods_supported: client.client_secret
      ? ['client_secret_basic', 'client_secret_post'] : ['none'],
  });
}
