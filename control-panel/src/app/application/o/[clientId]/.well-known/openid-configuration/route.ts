import { NextRequest, NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';
import { getClient } from '@/lib/identity/store';

// Per-client OIDC discovery. The `issuer` MUST equal this document's URL prefix
// (RFC 8414 / OIDC Discovery §4.3) — the per-client authority the app is
// configured with, `${externalUrl}/application/o/<clientId>/` — or strict clients
// (the Rust openidconnect crate, Spring Security, go-oidc) reject it. The OAuth
// endpoints themselves are shared: the client is identified by client_id, not the
// URL path.
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
  return NextResponse.json({
    issuer: `${config.externalUrl}/application/o/${clientId}/`,
    authorization_endpoint: `${config.externalUrl}/application/o/authorize/`,
    token_endpoint: `${config.externalUrl}/application/o/token`,
    userinfo_endpoint: `${config.externalUrl}/application/o/userinfo`,
    jwks_uri: `${config.externalUrl}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups', 'immich_role'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
}
