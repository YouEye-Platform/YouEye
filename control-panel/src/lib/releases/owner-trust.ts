import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseVersionStrict } from '../version';

export const OWNER_TRUST_PATH = '/var/lib/youeye/update-trust.json';
export const OWNER_TRUST_SCHEMA = 'youeye.owner-update-trust.v1';
export type TrustScope = 'appliance' | 'spine' | 'cp' | 'ui' | 'app';
export interface OwnerGrant {
  publisher: string; repository: string; branch: string;
  scope: TrustScope; public_key: string; revoked: boolean;
}
export interface OwnerTrustPolicy { schema: typeof OWNER_TRUST_SCHEMA; grants: OwnerGrant[] }

export function validTrustBranch(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && !/[ ~^:?*[\\%\x00-\x1f\x7f]/.test(s) && !s.includes('..') && !s.includes('@{') && s.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
}

export function canonicalTrustRepository(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /[%\\\s]/.test(raw)) throw new Error('Trust repository must be an exact HTTPS owner/repository URL');
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(p => !p || p === '.' || p === '..')) throw new Error('Trust repository must name one owner and repository');
  return `${u.origin}/${parts.join('/')}`;
}
export function validateOwnerTrust(value: unknown): OwnerTrustPolicy {
  const p = value as OwnerTrustPolicy;
  if (!p || p.schema !== OWNER_TRUST_SCHEMA || !Array.isArray(p.grants) || p.grants.length > 128 || Object.keys(p).some(k => !['schema', 'grants'].includes(k))) throw new Error('Invalid owner trust policy');
  const seen = new Set<string>();
  for (const g of p.grants) {
    if (!g || Object.keys(g).some(k => !['publisher', 'repository', 'branch', 'scope', 'public_key', 'revoked'].includes(k)) || typeof g.publisher !== 'string' || !g.publisher.trim() || g.publisher.length > 100 || typeof g.repository !== 'string' || canonicalTrustRepository(g.repository) !== g.repository || !validTrustBranch(g.branch) || !['appliance', 'spine', 'cp', 'ui', 'app'].includes(g.scope) || typeof g.revoked !== 'boolean' || typeof g.public_key !== 'string') throw new Error('Invalid publisher grant');
    if (!/^-----BEGIN PUBLIC KEY-----\s+[A-Za-z0-9+/=\r\n]+\s+-----END PUBLIC KEY-----\s*$/.test(g.public_key) || createPublicKey(g.public_key).asymmetricKeyType !== 'ed25519') throw new Error('Expected one Ed25519 public key');
    const id = `${g.repository}\n${g.branch}\n${g.scope}`;
    if (seen.has(id)) throw new Error('Duplicate source/channel/scope grant');
    seen.add(id);
  }
  return p;
}
export function loadOwnerTrust(path = OWNER_TRUST_PATH): OwnerTrustPolicy {
  let raw: Buffer;
  try { raw = readFileSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schema: OWNER_TRUST_SCHEMA, grants: [] };
    throw error;
  }
  if (raw.length > 1024 * 1024) throw new Error('Owner trust policy too large');
  return validateOwnerTrust(JSON.parse(raw.toString('utf8')));
}
export function releaseTrustIdentity(raw: string) {
  const u = new URL(raw), parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download' || u.username || u.password || u.search || u.hash || /[\\]/.test(raw)) throw new Error('Not an exact release asset URL');
  const repository = canonicalTrustRepository(`${u.origin}/${parts[0]}/${parts[1]}`);
  let tag = decodeURIComponent(parts[4]), scope: TrustScope = 'app';
  const component = /^(appliance|spine|cp|ui)-/.exec(tag);
  if (component) { scope = component[1] as TrustScope; tag = tag.slice(component[0].length); }
  const marker = tag.lastIndexOf('-v');
  const branch = marker < 0 ? 'main' : tag.slice(0,marker);
  const version = marker < 0 ? tag.startsWith('v') ? tag.slice(1) : '' : tag.slice(marker+2);
  if (!validTrustBranch(branch) || !parseVersionStrict(version)) throw new Error('Unsupported release tag');
  return { repository, branch, scope };
}
export function ownerReleaseGrant(raw: string, scope?: TrustScope, policy = loadOwnerTrust()): OwnerGrant | undefined {
  if (policy.grants.length === 0) return undefined;
  const candidate = new URL(raw), parts = candidate.pathname.split('/').filter(Boolean);
  const repository = `${candidate.origin}/${parts[0]}/${parts[1]}`;
  if (!policy.grants.some(g => g.repository === repository)) return undefined;
  const identity = releaseTrustIdentity(raw);
  const grant = policy.grants.find(g => g.repository === identity.repository && g.branch === identity.branch && g.scope === (scope || identity.scope));
  if (grant?.revoked) throw new Error('Publisher trust revoked for this source and scope');
  return grant;
}
export async function saveOwnerTrust(policy: OwnerTrustPolicy, path = OWNER_TRUST_PATH) {
  validateOwnerTrust(policy);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(policy, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
    await rename(temp, path);
    const dir = await open(dirname(path), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  } finally { await unlink(temp).catch(() => undefined); }
}
