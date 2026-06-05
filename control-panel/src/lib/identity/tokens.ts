import { SignJWT, jwtVerify } from 'jose';
import { getSigningSecret, getUserById, type IdentityUser } from './store';
import { getIdentityConfig } from './config';

const SESSION_COOKIE = 'ye-id-session';

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

export async function createAccessToken(user: IdentityUser, clientId: string): Promise<string> {
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
    .setAudience(clientId)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key(secret));
}

export async function verifyBearerToken(token: string): Promise<IdentityUser | null> {
  try {
    const secret = await getSigningSecret();
    const config = await getIdentityConfig();
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

export { SESSION_COOKIE };

