/**
 * App-to-platform credential wire contract. Contains no secret material.
 * A projection is published only through the authenticated CP -> UI bridge.
 */
export const APP_SERVICE_CREDENTIAL_SCHEMA = 'youeye.app-service-credential/1';

export type AppCredentialStatus = 'prepared' | 'active' | 'revoked';

export interface AppCredentialProjection {
  schema: typeof APP_SERVICE_CREDENTIAL_SCHEMA;
  appId: string;
  installationId: string;
  generation: number;
  revision: number;
  status: AppCredentialStatus;
  verifierHash: string;
  createdAt: string;
  rotatedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

const APP_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const KEYS: Array<keyof AppCredentialProjection> = [
  'schema', 'appId', 'installationId', 'generation', 'revision', 'status',
  'verifierHash', 'createdAt', 'rotatedAt', 'revokedAt', 'expiresAt',
];

export function isCanonicalAppId(value: unknown): value is string {
  return typeof value === 'string' && APP_ID.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Reject unknown fields too: this boundary must never accept a raw secret. */
export function parseAppCredentialProjection(value: unknown): AppCredentialProjection {
  const fail = () => { throw new Error('Invalid app credential projection'); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).length !== KEYS.length || KEYS.some(key => !(key in data))) return fail();
  if (data.schema !== APP_SERVICE_CREDENTIAL_SCHEMA
    || !isCanonicalAppId(data.appId)
    || typeof data.installationId !== 'string' || !UUID.test(data.installationId)
    || !isRevision(data.generation) || !isRevision(data.revision)
    || !['prepared', 'active', 'revoked'].includes(String(data.status))
    || typeof data.verifierHash !== 'string' || !HASH.test(data.verifierHash)
    || !isTimestamp(data.createdAt)
    || (data.rotatedAt !== null && !isTimestamp(data.rotatedAt))
    || (data.revokedAt !== null && !isTimestamp(data.revokedAt))
    || (data.expiresAt !== null && !isTimestamp(data.expiresAt))) return fail();
  if ((data.status === 'revoked') !== (data.revokedAt !== null)) return fail();
  if (data.generation === 1 && data.rotatedAt !== null) return fail();
  if (data.generation !== 1 && data.rotatedAt === null) return fail();
  if (typeof data.rotatedAt === 'string' && typeof data.revokedAt === 'string'
    && Date.parse(data.revokedAt) < Date.parse(data.rotatedAt)) return fail();
  for (const timestamp of [data.rotatedAt, data.revokedAt, data.expiresAt]) {
    if (typeof timestamp === 'string' && Date.parse(timestamp) < Date.parse(data.createdAt as string)) return fail();
  }
  return Object.fromEntries(KEYS.map(key => [key, data[key]])) as unknown as AppCredentialProjection;
}

export function sameAppCredential(
  left: AppCredentialProjection,
  right: AppCredentialProjection,
): boolean {
  return KEYS.every(key => left[key] === right[key]);
}

/**
 * Revision compare-and-set and generation ordering are separate protections.
 * A higher revision cannot reactivate a revoked or retired generation.
 */
export function checkAppCredentialTransition(
  current: AppCredentialProjection | null,
  incoming: AppCredentialProjection,
  expectedRevision: number,
): 'apply' | 'unchanged' {
  const next = parseAppCredentialProjection(incoming);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('App credential revision conflict');
  }
  if (current && sameAppCredential(current, next)
    && expectedRevision === current.revision - 1) return 'unchanged';
  if (expectedRevision !== (current?.revision ?? 0)
    || next.revision !== expectedRevision + 1) {
    throw new Error('App credential revision conflict');
  }
  if (!current) {
    if (next.generation !== 1 || next.status !== 'prepared') {
      throw new Error('App credential must be provisioned before activation');
    }
    return 'apply';
  }
  if (next.appId !== current.appId) throw new Error('App credential identity conflict');
  if (next.installationId !== current.installationId) {
    if (current.status !== 'revoked' || next.generation !== 1 || next.status !== 'prepared'
      || next.verifierHash === current.verifierHash
      || Date.parse(next.createdAt) < Date.parse(current.revokedAt!)) {
      throw new Error('App credential reinstall requires revocation');
    }
    return 'apply';
  }
  if (next.createdAt !== current.createdAt) throw new Error('App credential identity conflict');
  if (next.generation === current.generation) {
    if (current.status === 'revoked'
      || next.verifierHash !== current.verifierHash
      || next.rotatedAt !== current.rotatedAt
      || next.expiresAt !== current.expiresAt
      || !(next.status === 'revoked' || (current.status === 'prepared' && next.status === 'active'))) {
      throw new Error('App credential generation conflict');
    }
  } else if (next.generation !== current.generation + 1
    || next.status !== 'prepared'
    || next.verifierHash === current.verifierHash
    || Date.parse(next.rotatedAt!) < Date.parse(current.revokedAt ?? current.rotatedAt ?? current.createdAt)) {
    throw new Error('App credential generation conflict');
  }
  return 'apply';
}

/** Headers combines duplicates with a comma, which is deliberately rejected. */
export function parseAppBearer(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (!authorization || authorization.length > 4096) return null;
  const match = /^Bearer ([A-Za-z0-9._~-]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

export function hasAppServiceAuthHeaders(headers: Headers): boolean {
  return ['authorization', 'x-youeye-app', 'x-youeye-user', 'x-ui-bridge-token', 'x-app-slug']
    .some(name => headers.has(name));
}

export function isActiveAppCredential(
  credential: AppCredentialProjection,
  now = Date.now(),
): boolean {
  try {
    const parsed = parseAppCredentialProjection(credential);
    return parsed.status === 'active' && parsed.revokedAt === null
      && (parsed.expiresAt === null || Date.parse(parsed.expiresAt) > now);
  } catch {
    return false;
  }
}

/** Apply a durable outbox atomically; intermediate generations are never visible. */
export function checkAppCredentialBatch(
  current: AppCredentialProjection | null,
  incoming: AppCredentialProjection[],
  expectedRevision: number,
): { result: 'apply' | 'unchanged'; credential: AppCredentialProjection } {
  if (!Array.isArray(incoming) || incoming.length < 1 || incoming.length > 24
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('App credential revision conflict');
  }
  const batch = incoming.map(parseAppCredentialProjection);
  if (batch[0].revision !== expectedRevision + 1) throw new Error('App credential revision conflict');
  for (let i = 1; i < batch.length; i++) {
    checkAppCredentialTransition(batch[i - 1], batch[i], batch[i - 1].revision);
  }
  const credential = batch[batch.length - 1];
  if (current && sameAppCredential(current, credential)) return { result: 'unchanged', credential };
  checkAppCredentialTransition(current, batch[0], expectedRevision);
  return { result: 'apply', credential };
}

/**
 * Explicit encrypted-restore reconciliation may cross a revision gap only to
 * establish denial. It cannot activate a secret or rewind either authority.
 * Ordinary registration/publication must continue using the sequential CAS.
 */
export function checkAppCredentialRestoreFence(
  current: AppCredentialProjection | null,
  incoming: AppCredentialProjection,
  expected: AppCredentialProjection | null,
): 'apply' | 'unchanged' {
  const next = parseAppCredentialProjection(incoming);
  const prior = expected ? parseAppCredentialProjection(expected) : null;
  if (next.status !== 'revoked' || (prior && next.appId !== prior.appId)) {
    throw new Error('App credential restore conflict');
  }
  if (current && sameAppCredential(current, next)) {
    // A fresh read after revocation or a lost ACK can observe the fence itself.
    // This acknowledges existing denial; it cannot activate or alter authority.
    if (prior && next.revision <= prior.revision && !sameAppCredential(next, prior)) {
      throw new Error('App credential restore conflict');
    }
    return 'unchanged';
  }
  if (next.revision <= (prior?.revision ?? 0)) throw new Error('App credential restore conflict');
  if ((current === null) !== (prior === null)
    || (current && prior && !sameAppCredential(current, prior))
    || (current && next.revision <= current.revision)) throw new Error('App credential restore conflict');
  return 'apply';
}
