import { createHash, createPublicKey, verify } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseReleaseVersion } from '../version';
import { loadOwnerTrust, canonicalTrustRepository, validTrustBranch, type TrustScope } from './owner-trust';
import { RELEASE_DEVELOPMENT_TRUST } from './development-trust';
import { releaseCacheFetch } from './cache';
import publicTrust from '../../../../spine/internal/systemupdate/public-release-trust.json';

export type CoreBlob = { name: string; url: string; sha256: string; size_bytes: number };
export type CoreMember = {
  role: string; build_version: string; source: string; branch: string; source_commit: string;
  tag: string; input_sha256: string; key_id: string; depends_on: string[];
  artifact: CoreBlob; checksums: CoreBlob; signature: CoreBlob; provenance: CoreBlob; sbom: CoreBlob;
  document_signature?: CoreBlob; release_lock?: CoreBlob;
};
export type CoreRelease = {
  schema: 'youeye.core-release.v1'; version: string; tag: string; source: string; branch: string;
  source_commit: string; channel: string; sequence: number; previous_manifest_sha256?: string;
  minimum_reader: number; signer_sha256: string;
  compatibility: { state_min: number; state_max: number; data_min: number; data_max: number; minimum_release: string; capabilities: string[] };
  members: CoreMember[];
};
const ROLES = ['installer', 'media', 'appliance', 'system-update', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap', 'spine', 'cp', 'ui'];
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const commit = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const asset = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s);
export const canonicalCoreTag = (s: string) => s.startsWith('youeye-v') && !!parseReleaseVersion(s.slice(8));
export const validCoreBranch = validTrustBranch;

export function coreMemberChannel(member: CoreMember, assemblyChannel: string): string {
  if (member.source !== 'https://github.com/YouEye-Platform/YouEye') return assemblyChannel;
  const version = parseReleaseVersion(member.build_version);
  if (version && member.branch === 'main' && !version.token) return 'stable';
  if (version && member.branch === 'beta' && version.token === 'beta') return 'beta';
  throw new Error('Core member has no compatible public source branch');
}

function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported core manifest fields');
}
// Signed JSON must have one interpretation in both the Go host and this reader.
// Parse tokens before JSON.parse to reject duplicates at every nesting level.
function uniqueJSON(raw: string) {
  let pos = 0;
  const ws = () => { while (/\s/.test(raw[pos] ?? '') && pos < raw.length) pos++; };
  const string = () => {
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(raw.slice(pos));
    if (!match) throw new Error('Invalid core JSON string'); pos += match[0].length; return JSON.parse(match[0]) as string;
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error('Core JSON nesting exceeds limit'); ws();
    const kind = raw[pos];
    if (kind === '{' || kind === '[') {
      pos++; ws(); const seen = new Set<string>(), end = kind === '{' ? '}' : ']';
      if (raw[pos] !== end) while (true) {
        if (kind === '{') { ws(); const k = string(); if (seen.has(k)) throw new Error('Duplicate core JSON key'); seen.add(k); ws(); if (raw[pos++] !== ':') throw new Error('Invalid core JSON'); }
        value(depth + 1); ws(); if (raw[pos] === end) break; if (raw[pos++] !== ',') throw new Error('Invalid core JSON');
      }
      pos++; return;
    }
    if (kind === '"') { string(); return; }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(raw.slice(pos));
    if (!token) throw new Error('Invalid core JSON'); pos += token[0].length;
  };
  value(0); ws(); if (pos !== raw.length) throw new Error('Trailing core JSON');
}
export function parseCoreRelease(raw: Buffer): CoreRelease {
  if (!raw.length || raw.length > 1024 * 1024) throw new Error('Core manifest size is invalid');
  uniqueJSON(raw.toString('utf8'));
  const r = JSON.parse(raw.toString('utf8')) as CoreRelease;
  fields(r, ['schema','version','tag','source','branch','source_commit','channel','sequence','previous_manifest_sha256','minimum_reader','signer_sha256','compatibility','members']);
  const v = parseReleaseVersion(r.version);
  if (r.schema !== 'youeye.core-release.v1' || !v || r.tag !== `youeye-v${r.version}` || r.minimum_reader !== 1 || canonicalTrustRepository(r.source) !== r.source || !validCoreBranch(r.branch) || !commit(r.source_commit) || !hash(r.signer_sha256) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.previous_manifest_sha256 !== undefined && !hash(r.previous_manifest_sha256)) throw new Error('Invalid core identity');
  if (r.channel === 'stable' ? !!v.token : ['alpha','beta','dev'].includes(r.channel) ? v.token !== r.channel : r.channel !== 'feature' || !v.token || ['alpha','beta','dev'].includes(v.token)) throw new Error('Core channel and version differ');
  const c = r.compatibility;
  fields(c, ['state_min','state_max','data_min','data_max','minimum_release','capabilities']);
  if (![c.state_min,c.state_max,c.data_min,c.data_max].every(n => Number.isSafeInteger(n) && n > 0) || c.state_min > c.state_max || c.data_min > c.data_max || !parseReleaseVersion(c.minimum_release) || !Array.isArray(c.capabilities) || !c.capabilities.includes('core-release-v1') || c.capabilities.some(x => typeof x !== 'string' || !x) || new Set(c.capabilities).size !== c.capabilities.length) throw new Error('Unsupported core compatibility');
  if (!Array.isArray(r.members) || r.members.length !== ROLES.length) throw new Error('Incomplete core membership');
  const seen = new Set<string>();
  for (const m of r.members) {
    fields(m, ['role','build_version','source','branch','source_commit','tag','input_sha256','key_id','depends_on','artifact','checksums','signature','provenance','sbom','document_signature','release_lock']);
    if (!ROLES.includes(m.role) || seen.has(m.role) || !parseReleaseVersion(m.build_version) || canonicalTrustRepository(m.source) !== m.source || !validCoreBranch(m.branch) || !commit(m.source_commit) || !hash(m.input_sha256) || !hash(m.key_id) || !m.tag) throw new Error('Invalid core member');
    if (['stable','beta'].includes(r.channel)) {
      if (m.source !== r.source) throw new Error('Public core member source differs');
      coreMemberChannel(m, r.channel);
    }
    const blob = (b: CoreBlob) => {
      fields(b, ['name','url','sha256','size_bytes']);
      const prefix = `${m.source}/releases/download/${encodeURIComponent(m.tag)}/`;
      const u = new URL(b.url), name = decodeURIComponent(b.url.slice(prefix.length));
      if (!asset(b.name) || !hash(b.sha256) || !Number.isSafeInteger(b.size_bytes) || b.size_bytes <= 0 || !b.url.startsWith(prefix) || u.username || u.password || u.search || u.hash || !name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) throw new Error('Invalid exact core blob');
    };
    [m.artifact,m.checksums,m.signature,m.provenance,m.sbom].forEach(blob);
    if (['appliance','system-update'].includes(m.role)) { if (!m.document_signature) throw new Error('Missing host document signature'); blob(m.document_signature); }
    else if (m.document_signature) throw new Error('Unexpected document signature');
    if (m.role === 'appliance') { if (!m.release_lock) throw new Error('Missing resolved lock'); blob(m.release_lock); }
    else if (m.release_lock) throw new Error('Unexpected resolved lock');
    const deps = m.depends_on ?? [];
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(d => !seen.has(d)) || m.role === 'cp' && !deps.includes('spine') || m.role === 'ui' && !deps.includes('cp')) throw new Error('Invalid core dependency order');
    seen.add(m.role);
  }
  return r;
}
function roleKey(source: string, branch: string, channel: string, role: string) {
  const scope: TrustScope = ['spine','cp','ui'].includes(role) ? role as TrustScope : 'appliance';
  const grant = loadOwnerTrust().grants.find(g => g.repository === source && g.branch === branch && g.scope === scope);
  if (grant?.revoked) throw new Error('Core publisher authority is revoked');
  if (grant) return createPublicKey(grant.public_key);
  if (new URL(source).hostname === 'github.com') {
    if (source !== 'https://github.com/YouEye-Platform/YouEye' || !(channel === 'stable' && branch === 'main' || channel === 'beta' && branch === 'beta')) throw new Error('Core source has no provisioned public authority');
    const pem = (publicTrust.keys as Record<string,string>)[channel];
    if (publicTrust.schema !== 'youeye.public-trust.v1' || !pem) throw new Error('Public core authority is not provisioned');
    return createPublicKey(pem);
  }
  return createPublicKey(RELEASE_DEVELOPMENT_TRUST);
}
function keyHash(key: ReturnType<typeof createPublicKey>) { return sha(key.export({type:'spki',format:'der'}) as Buffer); }
export function verifyCoreRelease(raw: Buffer, sig: Buffer): CoreRelease {
  const r = parseCoreRelease(raw), key = roleKey(r.source, r.branch, r.channel, 'assembly');
  if (sig.length !== 64 || keyHash(key) !== r.signer_sha256 || !verify(null, raw, key, sig)) throw new Error('Core selection signature rejected');
  return r;
}
export function loadSelectedCoreDocument(root = '/var/lib/youeye-state/core-selection') {
  const read = (name: string, max: number) => {
    const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.mode & 0o022 || st.size <= 0 || st.size > max || st.uid !== process.getuid?.()) throw new Error('Unsafe core selection state');
      const bytes = Buffer.alloc(st.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
      if (count !== st.size) throw new Error('Core selection changed during read');
      return bytes.subarray(0, count);
    } finally { closeSync(fd); }
  };
  const raw = read('core-release.json', 1024*1024);
  return { release: verifyCoreRelease(raw, read('core-release.json.sig', 64)), manifestSHA256: sha(raw) };
}
export function loadSelectedCore(root = '/var/lib/youeye-state/core-selection'): CoreRelease {
  return loadSelectedCoreDocument(root).release;
}
export function selectedCoreRole(role: 'cp' | 'ui', root?: string) {
  const { release, manifestSHA256 } = loadSelectedCoreDocument(root);
  const member = release.members.find(m => m.role === role);
  if (!member) throw new Error('Selected core role is missing');
  const key = roleKey(member.source, member.branch, coreMemberChannel(member, release.channel), role);
  if (keyHash(key) !== member.key_id) throw new Error('Current core role authority differs');
  return { release, manifestSHA256, member, key };
}
export function selectedCoreArtifact(url: string, digest: string | undefined, role: TrustScope | undefined, root?: string) {
  const tag = decodeURIComponent(new URL(url).pathname.split('/')[5] ?? '');
  if (!canonicalCoreTag(tag)) return null;
  const { release: r, manifestSHA256 } = loadSelectedCoreDocument(root), m = r.members.find(m => m.role === role);
  if (!m || m.artifact.url !== url || !digest || m.artifact.sha256 !== digest) throw new Error('Artifact differs from frozen core selection');
  const key = roleKey(m.source,m.branch,coreMemberChannel(m,r.channel),m.role);
  if (keyHash(key) !== m.key_id) throw new Error('Core role authority differs');
  return { release:r, member:m, key, manifestSHA256 };
}
async function metadata(b: CoreBlob): Promise<Buffer> {
  if (b.size_bytes > 1024*1024) throw new Error('Core metadata exceeds limit');
  const response = await releaseCacheFetch(b.url, {signal:AbortSignal.timeout(30_000)});
  if (!response.ok || !response.body) throw new Error('Core metadata unavailable');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try { while (true) { const {done,value} = await reader.read(); if (done) break; length += value.length; if (length > b.size_bytes) throw new Error('Oversized core metadata'); chunks.push(value); } } finally { await reader.cancel(); }
  const raw = Buffer.concat(chunks);
  if (raw.length !== b.size_bytes || sha(raw) !== b.sha256) throw new Error('Exact core metadata differs');
  return raw;
}
export async function verifyCoreArtifactBuffer(selected: NonNullable<ReturnType<typeof selectedCoreArtifact>>, bytes: Buffer) {
  const { member:m, key } = selected;
  if (bytes.length !== m.artifact.size_bytes || sha(bytes) !== m.artifact.sha256) throw new Error('Core artifact differs');
  const sums = await metadata(m.checksums), sig = await metadata(m.signature);
  if (sig.length !== 64 || !verify(null,sums,key,sig)) throw new Error('Core role checksum signature rejected');
  const entries = new Map<string,string>();
  for (const line of sums.toString('utf8').trimEnd().split('\n')) { const p = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/.exec(line); if (!p || entries.has(p[2])) throw new Error('Malformed role checksums'); entries.set(p[2],p[1]); }
  for (const b of [m.artifact,m.provenance,m.sbom]) { if (entries.get(b.name) !== b.sha256) throw new Error('Core member is not role-signed'); }
  await metadata(m.provenance); await metadata(m.sbom);
  return m.artifact.sha256;
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
export function coreArtifactVerificationShell(selected: NonNullable<ReturnType<typeof selectedCoreArtifact>>, path: string): string {
  const {member:m,key} = selected;
  const pem = key.export({type:'spki',format:'pem'}).toString();
  return `
set -eu
core_verify_dir=$(mktemp -d /tmp/youeye-core-verify.XXXXXX)
trap 'rm -rf -- "$core_verify_dir"' EXIT
printf %s ${quote(Buffer.from(pem).toString('base64'))} | base64 -d > "$core_verify_dir/key.pub"
${[m.checksums,m.signature,m.provenance,m.sbom].map((b,i) => `curl --max-time 120 -fsSL ${quote(b.url)} -o "$core_verify_dir/${i}"
test "$(stat -c %s "$core_verify_dir/${i}")" = ${quote(String(b.size_bytes))}
test "$(sha256sum "$core_verify_dir/${i}" | awk '{print $1}')" = ${quote(b.sha256)}`).join('\n')}
openssl pkeyutl -verify -pubin -inkey "$core_verify_dir/key.pub" -rawin -in "$core_verify_dir/0" -sigfile "$core_verify_dir/1" >/dev/null
${[m.artifact,m.provenance,m.sbom].map(b => `test "$(awk -v name=${quote(b.name)} '$2==name {count++; digest=$1} END {if(count==1) print digest}' "$core_verify_dir/0")" = ${quote(b.sha256)}`).join('\n')}
test "$(stat -c %s ${quote(path)})" = ${quote(String(m.artifact.size_bytes))}
test "$(sha256sum ${quote(path)} | awk '{print $1}')" = ${quote(m.artifact.sha256)}
rm -rf -- "$core_verify_dir"
trap - EXIT
`;
}
