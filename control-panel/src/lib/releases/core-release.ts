import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseReleaseVersion } from '../version';

/**
 * Reader for the unsigned System release document (`youeye.core-release.v1`).
 *
 * The Control Panel never decides release trust itself. Spine accepts the
 * document by its exact SHA-256 and records it in protected State; this module
 * only reads those accepted bytes and binds CP/UI artifacts to their member
 * entry by SHA-256 and size.
 */
export type CoreBlob = { name: string; url: string; sha256: string; size_bytes: number };
export type CoreRole = 'cp' | 'ui';
export type CoreMember = {
  role: string; build_version: string; source: string; branch: string; source_commit: string;
  tag: string; input_sha256: string; depends_on?: string[];
  artifact: CoreBlob; build_inputs?: CoreBlob;
};
export type CoreRelease = {
  schema: 'youeye.core-release.v1'; version: string; tag: string; source: string; branch: string;
  source_commit: string; channel: string; sequence: number; previous_manifest_sha256?: string;
  minimum_reader: number; authority: 'digest';
  compatibility: { state_min: number; state_max: number; data_min: number; data_max: number; minimum_release: string; capabilities: string[] };
  members: CoreMember[];
};
export type SelectedCoreDocument = { release: CoreRelease; raw: Buffer; manifestSHA256: string };
export type SelectedCoreArtifact = SelectedCoreDocument & { member: CoreMember };

const ROLES = ['installer', 'media', 'appliance', 'system-update', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'update-bootstrap', 'spine', 'cp', 'ui'];
const SELECTION_ROOT = '/var/lib/youeye-state/core-selection';
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const commit = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
const asset = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s);
export const canonicalCoreTag = (s: string) => s.startsWith('youeye-v') && !!parseReleaseVersion(s.slice(8));

export function validReleaseBranch(s: unknown): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= 128 && !/[ ~^:?*[\\%\x00-\x1f\x7f]/.test(s) && !s.includes('..') && !s.includes('@{') && s.split('/').every(p => p && !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'));
}
export const validCoreBranch = validReleaseBranch;

/** Exact HTTPS owner/repository URL; release blob URLs must sit beneath it. */
export function canonicalReleaseRepository(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /[%\\\s]/.test(raw)) throw new Error('Release repository must be an exact HTTPS owner/repository URL');
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(p => !p || p === '.' || p === '..')) throw new Error('Release repository must name one owner and repository');
  return `${u.origin}/${parts.join('/')}`;
}

/** Public members must come from the public branch matching their version. */
function coreMemberChannel(member: CoreMember, assemblyChannel: string): string {
  if (member.source !== 'https://github.com/YouEye-Platform/YouEye') return assemblyChannel;
  const version = parseReleaseVersion(member.build_version);
  if (version && member.branch === 'main' && !version.token) return 'stable';
  if (version && member.branch === 'beta' && version.token === 'beta') return 'beta';
  throw new Error('Core member has no compatible public source branch');
}

function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported core manifest fields');
}
// Release JSON must have one interpretation in both the Go host and this reader.
// Parse tokens before JSON.parse to reject duplicates at every nesting level.
export function uniqueJSON(raw: string, integerNumbers = false) {
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
    if (!token) throw new Error('Invalid core JSON');
    if (integerNumbers && /^-?\d/.test(token[0]) && /[.eE]/.test(token[0])) throw new Error('Core integer requires an integer JSON token');
    pos += token[0].length;
  };
  value(0); ws(); if (pos !== raw.length) throw new Error('Trailing core JSON');
}

export function parseCoreRelease(raw: Buffer): CoreRelease {
  if (!raw.length || raw.length > 1024 * 1024) throw new Error('Core manifest size is invalid');
  uniqueJSON(raw.toString('utf8'), true);
  const r = JSON.parse(raw.toString('utf8')) as CoreRelease;
  fields(r, ['schema','version','tag','source','branch','source_commit','channel','sequence','previous_manifest_sha256','minimum_reader','authority','compatibility','members']);
  const v = parseReleaseVersion(r.version);
  if (r.schema !== 'youeye.core-release.v1' || r.authority !== 'digest' || !v || r.tag !== `youeye-v${r.version}` || r.minimum_reader !== 1 || canonicalReleaseRepository(r.source) !== r.source || !validCoreBranch(r.branch) || !commit(r.source_commit) || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.previous_manifest_sha256 !== undefined && !hash(r.previous_manifest_sha256)) throw new Error('Invalid core identity');
  if (r.channel === 'stable' ? !!v.token : ['alpha','beta','dev'].includes(r.channel) ? v.token !== r.channel : r.channel !== 'feature' || !v.token || ['alpha','beta','dev'].includes(v.token)) throw new Error('Core channel and version differ');
  const c = r.compatibility;
  fields(c, ['state_min','state_max','data_min','data_max','minimum_release','capabilities']);
  if (![c.state_min,c.state_max,c.data_min,c.data_max].every(n => Number.isSafeInteger(n) && n > 0) || c.state_min > c.state_max || c.data_min > c.data_max || !parseReleaseVersion(c.minimum_release) || !Array.isArray(c.capabilities) || !c.capabilities.includes('core-release-v1') || c.capabilities.some(x => typeof x !== 'string' || !x) || new Set(c.capabilities).size !== c.capabilities.length) throw new Error('Unsupported core compatibility');
  if (!Array.isArray(r.members) || r.members.length !== ROLES.length) throw new Error('Incomplete core membership');
  const seen = new Set<string>();
  for (const m of r.members) {
    fields(m, ['role','build_version','source','branch','source_commit','tag','input_sha256','depends_on','artifact','build_inputs']);
    if (!ROLES.includes(m.role) || seen.has(m.role) || !parseReleaseVersion(m.build_version) || canonicalReleaseRepository(m.source) !== m.source || !validCoreBranch(m.branch) || !commit(m.source_commit) || !hash(m.input_sha256) || typeof m.tag !== 'string' || !m.tag) throw new Error('Invalid core member');
    if (['stable','beta'].includes(r.channel)) coreMemberChannel(m, r.channel);
    const blob = (b: CoreBlob) => {
      fields(b, ['name','url','sha256','size_bytes']);
      const prefix = `${m.source}/releases/download/${encodeURIComponent(m.tag)}/`;
      const u = new URL(b.url), name = decodeURIComponent(b.url.slice(prefix.length));
      if (!asset(b.name) || !hash(b.sha256) || !Number.isSafeInteger(b.size_bytes) || b.size_bytes <= 0 || !b.url.startsWith(prefix) || u.username || u.password || u.search || u.hash || /[\\\x00]/.test(decodeURIComponent(u.pathname)) || !name || name === '.' || name === '..' || /[/\\\x00]/.test(name)) throw new Error('Invalid exact core blob');
    };
    blob(m.artifact);
    if (m.role === 'appliance') { if (!m.build_inputs) throw new Error('Missing appliance build inputs'); blob(m.build_inputs); }
    else if (m.build_inputs) throw new Error('Unexpected build inputs');
    const deps = m.depends_on ?? [];
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(d => !seen.has(d)) || m.role === 'cp' && !deps.includes('spine') || m.role === 'ui' && !deps.includes('cp')) throw new Error('Invalid core dependency order');
    seen.add(m.role);
  }
  return r;
}

/** Read the document Spine accepted into protected State; its digest is the root of trust. */
export function loadSelectedCoreDocument(root = SELECTION_ROOT): SelectedCoreDocument {
  const fd = openSync(join(root, 'core-release.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.mode & 0o022 || st.size <= 0 || st.size > 1024 * 1024 || st.uid !== process.getuid?.()) throw new Error('Unsafe core selection state');
    const bytes = Buffer.alloc(st.size + 1), count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count !== st.size) throw new Error('Core selection changed during read');
    raw = bytes.subarray(0, count);
  } finally { closeSync(fd); }
  return { release: parseCoreRelease(raw), raw, manifestSHA256: sha(raw) };
}
export function loadSelectedCore(root = SELECTION_ROOT): CoreRelease {
  return loadSelectedCoreDocument(root).release;
}
export function selectedCoreRole(role: CoreRole, root?: string): SelectedCoreArtifact {
  const document = loadSelectedCoreDocument(root);
  const member = document.release.members.find(m => m.role === role);
  if (!member) throw new Error('Selected core role is missing');
  return { ...document, member };
}
/** The member of the accepted selection for this exact URL, or null for a non-core artifact. */
export function selectedCoreArtifact(url: string, digest: string | undefined, role: CoreRole | undefined, root?: string): SelectedCoreArtifact | null {
  const tag = decodeURIComponent(new URL(url).pathname.split('/')[5] ?? '');
  const canonical = canonicalCoreTag(tag);
  if (!canonical && !['cp','ui'].includes(role ?? '')) return null;
  let document: SelectedCoreDocument;
  try { document = loadSelectedCoreDocument(root); }
  catch (error) { if (!canonical && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  const member = document.release.members.find(m => m.role === role);
  if (!member || member.artifact.url !== url) {
    if (!canonical) return null;
    throw new Error('Artifact differs from frozen core selection');
  }
  if (!digest || member.artifact.sha256 !== digest) throw new Error('Artifact differs from frozen core selection');
  return { ...document, member };
}
function coreBlobs(release: CoreRelease): CoreBlob[] {
  return release.members.flatMap(m => [m.artifact, ...(m.build_inputs ? [m.build_inputs] : [])]);
}
export function coreBlobTransportURL(release: CoreRelease, blob: CoreBlob, mirror = false): string {
  if (!coreBlobs(release).some(b => b.url === blob.url && b.name === blob.name && b.sha256 === blob.sha256 && b.size_bytes === blob.size_bytes)) throw new Error('Transport blob is outside the accepted core selection');
  if (mirror || !blob.url.startsWith(`${release.source}/releases/download/`)) return `${release.source}/releases/download/${release.tag}/blob-${blob.sha256}`;
  return blob.url;
}
export function selectedCoreTransportURL(url: string, mirror = false, root?: string): string {
  const parts = new URL(url).pathname.split('/').filter(Boolean);
  if (parts.length !== 6 || parts[2] !== 'releases' || parts[3] !== 'download') return url;
  let release: CoreRelease;
  try { release = loadSelectedCore(root); }
  catch (error) { if (!canonicalCoreTag(parts[4]) && (error as NodeJS.ErrnoException).code === 'ENOENT') return url; throw error; }
  const blob = coreBlobs(release).find(b => b.url === url);
  return blob ? coreBlobTransportURL(release, blob, mirror) : url;
}
export function verifyCoreArtifactBuffer(selected: SelectedCoreArtifact, bytes: Buffer): string {
  const { artifact } = selected.member;
  if (bytes.length !== artifact.size_bytes || sha(bytes) !== artifact.sha256) throw new Error('Core artifact differs from the accepted selection');
  return artifact.sha256;
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
function coreDownloadShell(primary: string, mirror: string, destination: string): string {
  const options = `--max-time 120 --max-redirs 5 --proto '=https' --proto-redir '=https' -fsSL`;
  if (primary === mirror) return `curl ${options} ${quote(primary)} -o ${destination}`;
  return `if ! core_http_status=$(curl ${options} -w '%{http_code}' ${quote(primary)} -o ${destination}); then
  if [ "$core_http_status" = 404 ]; then
    curl ${options} ${quote(mirror)} -o ${destination}
  else
    false
  fi
fi`;
}
export function selectedCoreDownloadShell(url: string, destination: string): string {
  return coreDownloadShell(selectedCoreTransportURL(url),selectedCoreTransportURL(url,true),quote(destination));
}
export function coreArtifactVerificationShell(selected: SelectedCoreArtifact, path: string): string {
  const { artifact } = selected.member;
  return `
set -eu
test "$(stat -c %s ${quote(path)})" = ${quote(String(artifact.size_bytes))}
test "$(sha256sum ${quote(path)} | awk '{print $1}')" = ${quote(artifact.sha256)}
`;
}
