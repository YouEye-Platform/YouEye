import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'crypto';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
  SignJWT,
  jwtVerify,
  type JWK,
} from 'jose';
import { getIdentitySecret, getSigningSecret, getUserById, getIdentitySessionById, isAccessTokenRevoked, isUserTokenInvalidated, setIdentitySecretIfAbsent, getOAuthSigningKeySnapshot, rotateOAuthSigningKey, type IdentityUser } from './store';
import { getIdentityConfig } from './config';
import { getClientIssuer } from './issuer';

const SESSION_COOKIE = 'ye-id-session';
const OAUTH_RS256_PRIVATE_KEY = 'oauth-rs256-private-key';

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export const IDENTITY_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export async function createIdentityToken(user: IdentityUser, sessionId?: string, maxAgeSeconds = IDENTITY_SESSION_MAX_AGE_SECONDS): Promise<string> {
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
    ...(sessionId ? { sid: sessionId } : {}),
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
    if (!result.payload.iat || (!result.payload.sid && await isUserTokenInvalidated(sub, result.payload.iat))) return null;
    if (result.payload.sid) {
      const session = await getIdentitySessionById(String(result.payload.sid), true);
      if (!session || session.user_id !== sub) return null;
    } else if (result.payload.iat && result.payload.iat < Math.floor(Date.now() / 1000) - 86400) {
      return null;
    }
    const user = await getUserById(sub);
    return user?.is_active ? user : null;
  } catch {
    return null;
  }
}

export async function identityTokenClaims(token: string): Promise<{ sub: string; sid: string | null } | null> {
  try {
    const [secret, config] = await Promise.all([getSigningSecret(), getIdentityConfig()]);
    const result = await jwtVerify(token, key(secret), { issuer: config.issuer, audience: 'youeye-id' });
    return result.payload.sub ? { sub: result.payload.sub, sid: typeof result.payload.sid === 'string' ? result.payload.sid : null } : null;
  } catch {
    return null;
  }
}

export async function identitySessionFromCookie(token: string): Promise<{ sub: string; sid: string } | null> {
  const claims = await identityTokenClaims(token);
  if (!claims?.sid) return null;
  const session = await getIdentitySessionById(claims.sid);
  return session?.user_id === claims.sub ? { sub: claims.sub, sid: claims.sid } : null;
}

async function getOAuthPrivateKeyPem(): Promise<string> {
  const existing = await getIdentitySecret(OAUTH_RS256_PRIVATE_KEY);
  if (existing) return existing;

  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const pem = await exportPKCS8(privateKey);
  return setIdentitySecretIfAbsent(OAUTH_RS256_PRIVATE_KEY, pem);
}

async function publicJwkFromPem(pem: string): Promise<JWK> {
  const privateKey = createPrivateKey(pem);
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

async function getOAuthPublicJwk(): Promise<JWK> {
  return publicJwkFromPem(await getOAuthPrivateKeyPem());
}

async function verificationKey(token: string) {
  const header = decodeProtectedHeader(token);
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid signing key header');
  await getOAuthPrivateKeyPem();
  const snapshot = await getOAuthSigningKeySnapshot();
  const candidates = [snapshot.active, ...snapshot.retired];
  for (const pem of candidates) {
    const jwk = await publicJwkFromPem(pem);
    if (jwk.kid === header.kid) return importJWK(jwk, 'RS256');
  }
  throw new Error('Unknown signing key');
}

export async function rotateOAuthKey(): Promise<string> {
  const previous = await getOAuthPrivateKeyPem();
  const previousKid = String((await publicJwkFromPem(previous)).kid);
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  const replacement = await exportPKCS8(privateKey);
  if (!await rotateOAuthSigningKey(previous, replacement, previousKid)) {
    throw new Error('The signing key changed during rotation; retry after inspecting the active key');
  }
  return String((await publicJwkFromPem(replacement)).kid);
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

export async function createAccessToken(user: IdentityUser, clientId: string, scope = '', sessionId?: string | null,
  authorizedAt = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = await getOAuthPrivateKeyPem();
  const [privateKey, jwk] = await Promise.all([importPKCS8(pem, 'RS256'), publicJwkFromPem(pem)]);
  const claims = { scope, client_id: clientId, token_use: 'access', ...(sessionId ? { sid: sessionId } : {}) };
  // Per-client issuer: must equal what the per-client discovery doc advertises and
  // the authority the app is configured with, or strict clients (the Rust openidconnect
  // crate, Spring Security, go-oidc) reject the token. For app clients this is the
  // clientId-derived INTERNAL authority (http://<app-gw>:3002/application/o/<clientId>/),
  // so the token validates even under full network isolation; first-party clients
  // (and resolution failures) get the external authority.
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid), typ: 'at+jwt' })
    .setSubject(user.id)
    .setIssuer(await getClientIssuer(clientId))
    .setAudience('youeye-userinfo')
    .setJti(randomUUID())
    .setIssuedAt(authorizedAt)
    .setExpirationTime('1h')
    .sign(privateKey);
}

export async function createIdToken(user: IdentityUser, clientId: string, scope = '', nonce?: string | null, sessionId?: string | null,
  authorizedAt = Math.floor(Date.now() / 1000)): Promise<string> {
  const pem = await getOAuthPrivateKeyPem();
  const [privateKey, jwk] = await Promise.all([importPKCS8(pem, 'RS256'), publicJwkFromPem(pem)]);
  const claims = { ...oauthClaims(user, scope), token_use: 'id', ...(nonce ? { nonce } : {}), ...(sessionId ? { sid: sessionId } : {}) };
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid), typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(await getClientIssuer(clientId))
    .setAudience(clientId)
    .setIssuedAt(authorizedAt)
    .setExpirationTime('1h')
    .sign(privateKey);
}

export async function createLogoutToken(clientId: string, userId: string, sessionId: string, issuedAt = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!Number.isSafeInteger(issuedAt) || issuedAt <= 0 || issuedAt > Math.floor(Date.now() / 1000)) {
    throw new Error('Invalid logout issue time');
  }
  const pem = await getOAuthPrivateKeyPem();
  const [privateKey, jwk] = await Promise.all([importPKCS8(pem, 'RS256'), publicJwkFromPem(pem)]);
  return new SignJWT({
    sid: sessionId,
    events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
  })
    .setProtectedHeader({ alg: 'RS256', kid: String(jwk.kid), typ: 'logout+jwt' })
    .setIssuer(await getClientIssuer(clientId))
    .setAudience(clientId)
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + 24 * 60 * 60)
    .sign(privateKey);
}

export async function verifyClientIdToken(token: string, clientId: string): Promise<{ sub: string; sid: string | null } | null> {
  try {
    const key = await verificationKey(token);
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      audience: clientId,
      issuer: await getClientIssuer(clientId),
    });
    if (protectedHeader.typ !== 'JWT' || payload.token_use !== 'id' || !payload.sub) return null;
    return { sub: payload.sub, sid: typeof payload.sid === 'string' ? payload.sid : null };
  } catch {
    return null;
  }
}

export async function inspectAccessToken(token: string, clientId: string): Promise<{ jti: string; exp: number } | null> {
  try {
    const key = await verificationKey(token);
    const { payload, protectedHeader } = await jwtVerify(token, key, {
      audience: 'youeye-userinfo', issuer: await getClientIssuer(clientId),
    });
    if (protectedHeader.typ !== 'at+jwt' || payload.token_use !== 'access' || payload.client_id !== clientId || !payload.jti || !payload.exp) return null;
    return { jti: payload.jti, exp: payload.exp };
  } catch {
    return null;
  }
}

export async function verifyBearerToken(token: string): Promise<IdentityUser | null> {
  try {
    const publicKey = await verificationKey(token);
    const result = await jwtVerify(token, publicKey, { audience: 'youeye-userinfo' });
    if (result.protectedHeader.typ !== 'at+jwt' || result.payload.token_use !== 'access') return null;
    const clientId = String(result.payload.client_id || '');
    const issuer = String(result.payload.iss || '');
    if (!clientId || issuer !== await getClientIssuer(clientId)) return null;
    if (!result.payload.jti || await isAccessTokenRevoked(String(result.payload.jti))) return null;
    const sub = result.payload.sub;
    if (!sub) return null;
    const { evaluateClientAdmission, clientTokenRevoked } = await import('@/lib/admission/store');
    if (!(await evaluateClientAdmission(clientId, sub)).allowed || !result.payload.iat
      || await clientTokenRevoked(clientId, sub, result.payload.iat)) return null;
    if (!result.payload.iat || (!result.payload.sid && await isUserTokenInvalidated(sub, result.payload.iat))) return null;
    if (result.payload.sid) {
      const session = await getIdentitySessionById(String(result.payload.sid));
      if (!session || session.user_id !== sub) return null;
    }
    const user = await getUserById(sub);
    return user?.is_active ? user : null;
  } catch {
    return null;
  }
}

export async function getOAuthJWKS(): Promise<{ keys: JWK[] }> {
  await getOAuthPrivateKeyPem();
  const snapshot = await getOAuthSigningKeySnapshot();
  const keys = await Promise.all([snapshot.active, ...snapshot.retired].map(publicJwkFromPem));
  return { keys };
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
  const [pem, identity] = await Promise.all([getOAuthPrivateKeyPem(), getIdentityConfig()]);
  const [privateKey, jwk] = await Promise.all([importPKCS8(pem, 'RS256'), publicJwkFromPem(pem)]);
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
  const [pem, identity] = await Promise.all([getOAuthPrivateKeyPem(), getIdentityConfig()]);
  const [privateKey, jwk] = await Promise.all([importPKCS8(pem, 'RS256'), publicJwkFromPem(pem)]);
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
