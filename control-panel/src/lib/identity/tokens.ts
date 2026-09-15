import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'crypto';
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
import { getClientIssuer } from './issuer';

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
	given_name: user.first_name,
	family_name: user.last_name,
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
    const user = await getUserById(sub);
    return user?.is_active ? user : null;
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
  const isAdmin = user.is_admin || groups.includes('admin');
  const claims: Record<string, unknown> = {
    preferred_username: user.username,
	name: user.name,
	given_name: user.first_name,
	family_name: user.last_name,
    email: user.email,
    // YouEye owns the account lifecycle and sets the email at creation, so it is
    // verified by definition. Some clients (e.g. Vaultwarden, django-allauth)
    // refuse to provision an account whose email is not marked verified.
    email_verified: true,
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

export async function createAccessToken(user: IdentityUser, clientId: string, scope = '', nonce?: string | null): Promise<string> {
  const privateKey = await getOAuthPrivateKey();
  const jwk = await getOAuthPublicJwk();
  const claims = oauthClaims(user, scope);
  // OIDC: when the client sent a nonce in the auth request, the ID token MUST
  // echo it (and MUST NOT include one otherwise). Required by Authlib, Spring
  // Security, mod_auth_openidc, the Rust openidconnect crate, etc.
  if (nonce) claims.nonce = nonce;
  // Per-client issuer: must equal what the per-client discovery doc advertises and
  // the authority the app is configured with, or strict clients (the Rust openidconnect
  // crate, Spring Security, go-oidc) reject the token. For app clients this is the
  // clientId-derived INTERNAL authority (http://<app-gw>:3002/application/o/<clientId>/),
  // so the token validates even under full network isolation; first-party clients
  // (and resolution failures) get the external authority.
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid) })
    .setSubject(user.id)
    .setIssuer(await getClientIssuer(clientId))
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
    // OAuth access tokens carry a PER-CLIENT issuer that may be EXTERNAL (first-party,
    // non-isolated apps) or INTERNAL (http://<app-gw>:3002/application/o/<clientId>/),
    // so we can't pin a single value; the RS256 signature (our key alone) is the trust
    // boundary. We additionally require iss to be one of our `/application/o/<aud>/`
    // authorities — tying iss to the token's audience so it can't claim a foreign issuer.
    const result = await jwtVerify(token, publicKey);
    const iss = String(result.payload.iss || '');
    const audClaim = result.payload.aud;
    const aud = Array.isArray(audClaim) ? String(audClaim[0] || '') : String(audClaim || '');
    if (!aud || !/^https?:\/\//.test(iss) || !iss.endsWith(`/application/o/${aud}/`)) return null;
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

export const POINTER_PLATFORM_AUDIENCE = 'pointer-management';
export const POINTER_PLATFORM_SUBJECT = 'youeye-control';

export interface PointerLifecycleActor {
  id: string;
  name: string;
  isAdmin: boolean;
}

export const POINTER_SYSTEM_LIFECYCLE_ACTOR: PointerLifecycleActor = {
  id: 'youeye-system-lifecycle',
  name: 'YouEye system lifecycle',
  isAdmin: true,
};

/**
 * Mint the short-lived, user-attributed assertion used only on Pointer's
 * private management listener. The stable YouEye identity UUID is the actor
 * subject; username is presentation only and can change safely.
 */
export async function createPointerManagementAssertion(user: IdentityUser): Promise<string> {
  const [privateKey, jwk, identity] = await Promise.all([
    getOAuthPrivateKey(),
    getOAuthPublicJwk(),
    getIdentityConfig(),
  ]);
  const permissions = [
    'management.read',
    'providers.manage',
    'groups.manage',
    'applications.provision',
    'usage.read',
    'test.inference',
    ...(user.is_admin ? ['settings.manage'] : []),
  ];
  return new SignJWT({
    pointer_admin: user.is_admin,
    pointer_owner_scope: 'actor',
    pointer_permissions: permissions,
    act: {
      iss: identity.issuer,
      sub: user.id,
      name: user.name || user.username,
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid) })
    .setIssuer(identity.issuer)
    .setAudience(POINTER_PLATFORM_AUDIENCE)
    .setSubject(POINTER_PLATFORM_SUBJECT)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey);
}

/**
 * Mint a service-authority assertion for the narrowly scoped application
 * lifecycle API. The actor remains explicit for audit and, during install or
 * takeover, becomes the application's routing owner only when the request asks
 * Pointer to do so.
 */
export async function createPointerLifecycleAssertion(
  actor: PointerLifecycleActor
): Promise<string> {
  if (!actor.isAdmin || !actor.id.trim() || !actor.name.trim()) {
    throw new Error('Pointer application lifecycle requires an exact administrator actor');
  }
  const [privateKey, jwk, identity] = await Promise.all([
    getOAuthPrivateKey(),
    getOAuthPublicJwk(),
    getIdentityConfig(),
  ]);
  return new SignJWT({
    pointer_admin: true,
    pointer_permissions: ['management.read', 'applications.provision'],
    act: {
      iss: identity.issuer,
      sub: actor.id,
      name: actor.name,
    },
  })
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid) })
    .setIssuer(identity.issuer)
    .setAudience(POINTER_PLATFORM_AUDIENCE)
    .setSubject(POINTER_PLATFORM_SUBJECT)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('2m')
    .sign(privateKey);
}

export { SESSION_COOKIE };
