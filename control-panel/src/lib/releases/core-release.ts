import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { parseReleaseVersion } from '../version';

/**
 * Reader for the unsigned System release document (`youeye.core-release.v1`).
 *
 * The document is host-independent: it names artifacts, never locates them
 * (`releaseAssetURL`). It is read leniently: unknown fields are ignored, and a
 * higher `minimum_reader` or an unknown role is `ReleaseNeedsNewerReader`.
 *
 * The Control Panel never decides release trust itself. Spine accepts the
 * document by its exact SHA-256 and records it in protected State; this module
 * only reads those accepted bytes and binds CP/UI artifacts to their member
 * entry by SHA-256 and size.
 */
export type CoreBlob = { name: string; sha256: string; size_bytes: number; release?: string };
export type CoreRole = 'cp' | 'ui';
export type CoreMember = {
  role: string; build_version: string; source_tree: string; input_sha256: string; depends_on?: string[];
  artifact: CoreBlob; build_inputs?: CoreBlob;
};
export type CoreRelease = {
  /** `version` names the release (display, tag); `build` is the build version it carries (ordering). */
  schema: 'youeye.core-release.v1'; version: string; build: string; tag: string; source_tree: string; sequence: number;
  minimum_reader: number; authority: 'digest';
  compatibility: { state_min: number; state_max: number; data_min: number; data_max: number; minimum_release: string; capabilities: string[] };
  members: CoreMember[];
};
export type SelectedCoreDocument = { release: CoreRelease; raw: Buffer; manifestSHA256: string };
export type SelectedCoreArtifact = SelectedCoreDocument & { member: CoreMember };

const ROLES = ['installer', 'media', 'appliance', 'system-update', 'system-root', 'system-a-uki', 'system-b-uki', 'system-updater', 'internal-recovery', 'recovery-uki', 'spine', 'cp', 'ui'];
const SELECTION_ROOT = '/var/lib/youeye-state/core-selection';
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
export const validSourceTree = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const sha = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
export const validAssetName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(s);
export const validReleaseTag = (s: unknown): s is string => validAssetName(s) && s.length <= 128 && !s.includes('..');
export const canonicalCoreTag = (s: string) => s.startsWith('youeye-v') && !!parseReleaseVersion(s.slice(8));

/** Exact HTTPS owner/repository URL. */
export function canonicalReleaseRepository(raw: string): string {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || /[%\\\s]/.test(raw)) throw new Error('Release repository must be an exact HTTPS owner/repository URL');
  const parts = u.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(p) || p.endsWith('.'))) throw new Error('Release repository must name one owner and repository');
  return `${u.origin}/${parts.join('/')}`;
}

/**
 * Where a release file lives: `<downloadBase>/<tag>/<name>` when the channel
 * index names a download base for the release, else
 * `<repository>/releases/download/<tag>/<name>`; `tag` is `blob.release` when set.
 */
export function releaseAssetURL(repository: string, tag: string, blob: { name: string; release?: string }, downloadBase?: string): string {
  const path = `${encodeURIComponent(blob.release ?? tag)}/${encodeURIComponent(blob.name)}`;
  return downloadBase ? `${downloadBase}/${path}` : `${repository}/releases/download/${path}`;
}

/** Highest document reader this Control Panel implements (core and product releases). */
export const RELEASE_READER = 1;
/** A release document written for a newer reader (higher `minimum_reader`, or an unknown role). */
export class ReleaseNeedsNewerReader extends Error { override name = 'ReleaseNeedsNewerReader'; }

// Unknown fields are ignored: a later document may add some (they are covered
// by the document digest, never interpreted here).
function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid core manifest object');
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
  object(r);
  if (r.schema !== 'youeye.core-release.v1') throw new Error('Unsupported core release schema');
  if (Number.isSafeInteger(r.minimum_reader) && r.minimum_reader > RELEASE_READER) throw new ReleaseNeedsNewerReader(`Core release needs reader ${r.minimum_reader}`);
  if (r.authority !== 'digest' || !parseReleaseVersion(r.version) || typeof r.build !== 'string' || !parseReleaseVersion(r.build) || r.tag !== `youeye-v${r.version}` || r.minimum_reader !== 1 || !validSourceTree(r.source_tree) || !Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new Error('Invalid core identity');
  const c = r.compatibility;
  object(c);
  if (![c.state_min,c.state_max,c.data_min,c.data_max].every(n => Number.isSafeInteger(n) && n > 0) || c.state_min > c.state_max || c.data_min > c.data_max || !parseReleaseVersion(c.minimum_release) || !Array.isArray(c.capabilities) || !c.capabilities.includes('core-release-v1') || c.capabilities.some(x => typeof x !== 'string' || !x) || new Set(c.capabilities).size !== c.capabilities.length) throw new Error('Unsupported core compatibility');
  if (!Array.isArray(r.members)) throw new Error('Incomplete core membership');
  const seen = new Set<string>();
  for (const m of r.members) {
    object(m);
    if (!ROLES.includes(m.role)) throw new ReleaseNeedsNewerReader(`Core release names unknown role ${String(m.role).slice(0, 40)}`);
    if (seen.has(m.role) || !parseReleaseVersion(m.build_version) || !validSourceTree(m.source_tree) || !hash(m.input_sha256)) throw new Error('Invalid core member');
    const blob = (b: CoreBlob) => {
      object(b);
      if (!validAssetName(b.name) || !hash(b.sha256) || !Number.isSafeInteger(b.size_bytes) || b.size_bytes <= 0 || b.release !== undefined && !canonicalCoreTag(b.release)) throw new Error('Invalid exact core blob');
    };
    blob(m.artifact);
    if (m.role === 'appliance') { if (!m.build_inputs) throw new Error('Missing appliance build inputs'); blob(m.build_inputs); }
    else if (m.build_inputs) throw new Error('Unexpected build inputs');
    const deps = m.depends_on ?? [];
    if (!Array.isArray(deps) || new Set(deps).size !== deps.length || deps.some(d => !seen.has(d)) || m.role === 'cp' && !deps.includes('spine') || m.role === 'ui' && !deps.includes('cp')) throw new Error('Invalid core dependency order');
    seen.add(m.role);
  }
  if (seen.size !== ROLES.length) throw new Error('Incomplete core membership');
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
export function verifyCoreArtifactBuffer(selected: SelectedCoreArtifact, bytes: Buffer): string {
  const { artifact } = selected.member;
  if (bytes.length !== artifact.size_bytes || sha(bytes) !== artifact.sha256) throw new Error('Core artifact differs from the accepted selection');
  return artifact.sha256;
}
const quote = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
export function coreArtifactVerificationShell(selected: SelectedCoreArtifact, path: string): string {
  const { artifact } = selected.member;
  return `
set -eu
test "$(stat -c %s ${quote(path)})" = ${quote(String(artifact.size_bytes))}
test "$(sha256sum ${quote(path)} | awk '{print $1}')" = ${quote(artifact.sha256)}
`;
}
