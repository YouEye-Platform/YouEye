import { createHash, createPrivateKey, createPublicKey } from 'crypto';
import {
  calculateJwkThumbprint,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
  SignJWT,
  jwtVerify,
  type JWK,
} from 'jose';
import { getIdentitySecret, getSigningSecret, getUserById, setIdentitySecret, type IdentityUser } from './store';
import { getIdentityConfig } from './config';

const SESSION_COOKIE = 'ye-id-session';
const OAUTH_RS256_PRIVATE_KEY = 'oauth-rs256-private-key';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createIdentityToken(user: IdentityUser, maxAgeSeconds = 86400): Promise<string> {
  const secret = await getSigningSecret();
  const config = await getIdentityConfig();
  return new SignJWT({
    preferred_username: user.username,
    name: user.name,
    email: user.email,
    groups: user.groups,
    is_admin: user.is_admin,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuer(config.issuer)
    .setAudience('youeye-id')
    .setIssuedAt()
    .setExpirationTime(`${maxAgeSeconds}s`)
    .sign(key(secret));
}

export async function verifyIdentityToken(token: string): Promise<IdentityUser | null> {
  try {
    const secret = await getSigningSecret();
    const config = await getIdentityConfig();
    const result = await jwtVerify(token, key(secret), {
      issuer: config.issuer,
      audience: 'youeye-id',
    });
    const sub = result.payload.sub;
    if (!sub) return null;
    return getUserById(sub);
  } catch {
    return null;
  }
}

async function getOAuthPrivateKeyPem(): Promise<string> {
  const existing = await getIdentitySecret(OAUTH_RS256_PRIVATE_KEY);
  if (existing) return existing;

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  await setIdentitySecret(OAUTH_RS256_PRIVATE_KEY, pem);
  return pem;
}

async function getOAuthPrivateKey() {
  return importPKCS8(await getOAuthPrivateKeyPem(), 'RS256');
}

async function getOAuthPublicJwk(): Promise<JWK> {
  const privateKey = createPrivateKey(await getOAuthPrivateKeyPem());
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' }) as JWK;
  const publicJwk: JWK = {
    kty: jwk.kty,
    n: jwk.n,
    e: jwk.e,
    alg: 'RS256',
    use: 'sig',
  };
  const thumbprint = await calculateJwkThumbprint(publicJwk);
  return { ...publicJwk, kid: thumbprint };
}

function oauthClaims(user: IdentityUser, scope = ''): Record<string, unknown> {
  const groups = Array.from(new Set(user.groups || []));
  const isAdmin = user.is_admin || groups.includes('admin') || groups.includes('authentik Admins');
  const claims: Record<string, unknown> = {
    preferred_username: user.username,
    name: user.name,
    email: user.email,
    groups,
    is_admin: isAdmin,
  };

  for (const requestedScope of scope.split(/\s+/).filter(Boolean)) {
    if (requestedScope.endsWith('_role')) {
      claims[requestedScope] = isAdmin ? 'admin' : 'user';
    }
  }

  return claims;
}

export async function createAccessToken(user: IdentityUser, clientId: string, scope = ''): Promise<string> {
  const config = await getIdentityConfig();
  const privateKey = await getOAuthPrivateKey();
  const jwk = await getOAuthPublicJwk();
  return new SignJWT(oauthClaims(user, scope))
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid) })
    .setSubject(user.id)
    .setIssuer(config.issuer)
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}

export async function verifyBearerToken(token: string): Promise<IdentityUser | null> {
  const config = await getIdentityConfig();
  try {
    const jwk = await getOAuthPublicJwk();
    const publicKey = await importJWK(jwk, 'RS256');
    const result = await jwtVerify(token, publicKey, {
      issuer: config.issuer,
    });
    const sub = result.payload.sub;
    if (!sub) return null;
    return getUserById(sub);
  } catch {
    try {
      const secret = await getSigningSecret();
      const result = await jwtVerify(token, key(secret), {
        issuer: config.issuer,
      });
      const sub = result.payload.sub;
      if (!sub) return null;
      return getUserById(sub);
    } catch {
      return null;
    }
  }
}

export async function getOAuthJWKS(): Promise<{ keys: JWK[] }> {
  return { keys: [await getOAuthPublicJwk()] };
}

export async function getOAuthKeyId(): Promise<string> {
  const jwk = await getOAuthPublicJwk();
  return String(jwk.kid || createHash('sha256').update(JSON.stringify(jwk)).digest('hex'));
}

export { SESSION_COOKIE };
