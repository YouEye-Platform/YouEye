import { NextResponse } from 'next/server';
import { getIdentityConfig } from '@/lib/identity/config';

export async function GET() {
  const config = await getIdentityConfig();
  return NextResponse.json({
    issuer: config.issuer,
    authorization_endpoint: `${config.externalUrl}/application/o/authorize/`,
    token_endpoint: `${config.externalUrl}/application/o/token`,
    userinfo_endpoint: `${config.externalUrl}/application/o/userinfo`,
    jwks_uri: `${config.externalUrl}/oauth/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['HS256'],
    scopes_supported: ['openid', 'profile', 'email', 'groups'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  });
}
