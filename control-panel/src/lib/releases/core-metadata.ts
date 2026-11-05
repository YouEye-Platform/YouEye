import { createHash, verify, type KeyObject } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { coreMemberChannel, parseCoreRelease, uniqueJSON, type CoreBlob, type CoreMember, type CoreRelease } from './core-release';

const OFFICIAL = 'https://github.com/YouEye-Platform/YouEye';
const MAX = 1024 * 1024;
export const CORE_METADATA_ASSETS = ['core-release-v2.json', 'core-release-v2.json.sig', 'core-compatibility.json', 'core-compatibility.json.sig'] as const;
export type CoreSourceIdentity = { id: string; authority: string; repository: string };
export type CoreSourceBinding = { identity: CoreSourceIdentity; original_source: string; branch: string; role: string; key_id: string };
export type CoreMetadataProof = {
  schema: 'youeye.core-metadata-proof.v1'; execution_manifest_sha256: string; advertised: boolean;
  spine_checksums: string; spine_signature: string; spine_provenance: string;
  documents: { canonical: string | null; canonical_signature: string | null; pair: string | null; pair_signature: string | null };
  bindings: CoreSourceBinding[] | null;
};
export type CoreMetadataFacts = {
  schema: 'youeye.core-release.v1' | 'youeye.core-metadata.v2'; execution_manifest_sha256: string;
  canonical_manifest_sha256?: string; normalized_identity_sha256?: string; bindings?: CoreSourceBinding[];
};
const sha = (raw: Buffer | string) => createHash('sha256').update(raw).digest('hex');
function keyHash(key: KeyObject): string {
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Metadata authority must be Ed25519');
  return sha(key.export({ type: 'spki', format: 'der' }) as Buffer);
}
function exactFields(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported metadata fields');
}
function decode(raw: Buffer, integerNumbers = false): unknown {
  if (!raw.length || raw.length > MAX) throw new Error('Metadata exceeds bound');
  uniqueJSON(raw.toString('utf8'), integerNumbers);
  return JSON.parse(raw.toString('utf8'));
}
function bytes(value: unknown, limit: number): Buffer {
  if (value === null) return Buffer.alloc(0);
  if (typeof value !== 'string' || value.length > Math.ceil(limit / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid bounded metadata encoding');
  const raw = Buffer.from(value, 'base64');
  if (raw.length > limit || raw.toString('base64') !== value) throw new Error('Invalid metadata encoding');
  return raw;
}
/** Match Go encoding/json's compact struct order and HTML/U+2028 escaping. */
export function normalizedMetadataJSON(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n');
}
function identity(source: string, branch: string, channel: string): CoreSourceIdentity {
  let authority = 'development';
  const url = new URL(source);
  if (url.hostname.toLowerCase() === 'github.com') {
    authority = 'owner';
    if (source === OFFICIAL) {
      if (branch === 'main' && channel === 'stable') authority = 'official-stable';
      else if (branch === 'beta' && channel === 'beta') authority = 'official-beta';
      else throw new Error('Unsupported official metadata authority');
    }
  }
  return { id: sha(source), authority, repository: url.pathname.split('/').at(-1)! };
}
const content = (blob: CoreBlob) => ({ name: blob.name, sha256: blob.sha256, size_bytes: blob.size_bytes });
export function metadataFromExecution(release: CoreRelease) {
  const compatibility = release.compatibility;
  return {
    schema: 'youeye.core-metadata.v2', version: release.version, tag: release.tag,
    publisher: identity(release.source, release.branch, release.channel), branch: release.branch,
    source_commit: release.source_commit, channel: release.channel, sequence: release.sequence,
    ...(release.previous_manifest_sha256 ? { previous_execution_manifest_sha256: release.previous_manifest_sha256 } : {}),
    minimum_metadata_reader: 2, minimum_execution_reader: 1, execution_schema: release.schema,
    signer_sha256: release.signer_sha256, required_capabilities: ['paired-v2'],
    compatibility: { state_min: compatibility.state_min, state_max: compatibility.state_max,
      data_min: compatibility.data_min, data_max: compatibility.data_max,
      minimum_release: compatibility.minimum_release, capabilities: compatibility.capabilities },
    members: release.members.map(member => ({
      role: member.role, publisher: identity(member.source, member.branch, coreMemberChannel(member, release.channel)), branch: member.branch,
      build_origin: { version: member.build_version, tag: member.tag, source_commit: member.source_commit,
        input_sha256: member.input_sha256, provenance_sha256: member.provenance.sha256 },
      key_id: member.key_id, depends_on: member.depends_on ?? [], artifact: content(member.artifact),
      checksums: content(member.checksums), signature: content(member.signature),
      ...(member.document_signature ? { document_signature: content(member.document_signature) } : {}),
      ...(member.release_lock ? { release_lock: content(member.release_lock) } : {}),
      provenance: content(member.provenance), sbom: content(member.sbom),
    })),
  };
}
export function metadataSourceBindings(release: CoreRelease): CoreSourceBinding[] {
  return release.members.map(member => ({ identity: identity(member.source, member.branch, coreMemberChannel(member, release.channel)), original_source: member.source, branch: member.branch, role: member.role, key_id: member.key_id }));
}
export function spineMetadataRequired(member: CoreMember, key: KeyObject, checksums: Buffer, signature: Buffer, provenance: Buffer): boolean {
  if (member.role !== 'spine' || checksums.length > MAX || provenance.length > MAX || signature.length !== 64 || keyHash(key) !== member.key_id) throw new Error('Bounded original Spine authority required');
  for (const [blob, raw] of [[member.checksums, checksums], [member.signature, signature], [member.provenance, provenance]] as const) {
    if (raw.length !== blob.size_bytes || sha(raw) !== blob.sha256) throw new Error('Original Spine metadata differs');
  }
  if (!verify(null, checksums, key, signature)) throw new Error('Original Spine signature rejected');
  const entries = new Map<string, string>();
  for (const line of checksums.toString('utf8').replace(/\n$/, '').split('\n')) {
    const entry = /^([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._-]{0,199})$/.exec(line);
    if (!entry || entries.has(entry[2])) throw new Error('Malformed original Spine checksums');
    entries.set(entry[2], entry[1]);
  }
  for (const blob of [member.artifact, member.provenance, member.sbom]) if (entries.get(blob.name) !== blob.sha256) throw new Error('Spine checksum coverage differs');
  const parsed = decode(provenance);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Spine provenance must be an object');
  if (!Object.hasOwn(parsed, 'core_metadata')) return false;
  if ((parsed as Record<string, unknown>).core_metadata !== 'paired-v2') throw new Error('Unsupported signed metadata capability');
  return true;
}

export function verifyCoreMetadataProof(execution: Buffer, executionSignature: Buffer, proof: CoreMetadataProof, assemblyKey: KeyObject, roleKey: (member: CoreMember) => KeyObject): CoreMetadataFacts {
  const release = parseCoreRelease(execution), digest = sha(execution);
  if (executionSignature.length !== 64 || keyHash(assemblyKey) !== release.signer_sha256 || !verify(null, execution, assemblyKey, executionSignature)) throw new Error('Execution signature rejected');
  exactFields(proof, ['schema', 'execution_manifest_sha256', 'advertised', 'spine_checksums', 'spine_signature', 'spine_provenance', 'documents', 'bindings']);
  if (proof.schema !== 'youeye.core-metadata-proof.v1' || proof.execution_manifest_sha256 !== digest || typeof proof.advertised !== 'boolean') throw new Error('Metadata proof differs from exact execution');
  const bindings = release.members.map(member => {
    if (keyHash(roleKey(member)) !== member.key_id) throw new Error('Current scoped role authority differs');
    return { identity: identity(member.source, member.branch, coreMemberChannel(member, release.channel)), original_source: member.source, branch: member.branch, role: member.role, key_id: member.key_id };
  });
  const spine = release.members.find(member => member.role === 'spine')!;
  const required = spineMetadataRequired(spine, roleKey(spine), bytes(proof.spine_checksums, MAX), bytes(proof.spine_signature, 64), bytes(proof.spine_provenance, MAX));
  exactFields(proof.documents, ['canonical', 'canonical_signature', 'pair', 'pair_signature']);
  const canonical = bytes(proof.documents.canonical, MAX), canonicalSignature = bytes(proof.documents.canonical_signature, 64);
  const pair = bytes(proof.documents.pair, MAX), pairSignature = bytes(proof.documents.pair_signature, 64);
  const present = [canonical, canonicalSignature, pair, pairSignature].filter(raw => raw.length > 0).length;
  if (present !== 0 && present !== 4 || (required || proof.advertised) && present !== 4) throw new Error('Required or partial paired metadata proof');
  if (!present) {
    if (proof.bindings != null && (!Array.isArray(proof.bindings) || proof.bindings.length !== 0)) throw new Error('Legacy proof cannot enroll identities');
    return { schema: 'youeye.core-release.v1', execution_manifest_sha256: digest };
  }
  const value = decode(canonical, true), expected = metadataFromExecution(release);
  // Check semantic strings as well as raw bytes: JSON escapes cannot conceal
  // deployment addresses from the address-free identity contract.
  if (JSON.stringify(value).includes('://') || !isDeepStrictEqual(value, expected)) throw new Error('Canonical identity differs from authenticated execution');
  if (canonicalSignature.length !== 64 || !verify(null, canonical, assemblyKey, canonicalSignature)) throw new Error('Canonical signature rejected');
  const expectedPair = {
    schema: 'youeye.core-metadata-pair.v1', source_id: expected.publisher.id, branch: release.branch, sequence: release.sequence,
    execution_manifest_sha256: digest, canonical_manifest_sha256: sha(canonical),
    normalized_identity_sha256: sha(normalizedMetadataJSON(expected)), signer_sha256: release.signer_sha256,
  };
  if (!isDeepStrictEqual(decode(pair, true), expectedPair) || pairSignature.length !== 64 || !verify(null, pair, assemblyKey, pairSignature)) throw new Error('Signed compatibility pair differs');
  if (!isDeepStrictEqual(proof.bindings, bindings)) throw new Error('Protected source registry differs from current authority');
  return { schema: 'youeye.core-metadata.v2', execution_manifest_sha256: digest,
    canonical_manifest_sha256: expectedPair.canonical_manifest_sha256,
    normalized_identity_sha256: expectedPair.normalized_identity_sha256, bindings };
}

export function parseCoreMetadataProof(raw: Buffer): CoreMetadataProof {
  if (!raw.length || raw.length > 8 * MAX) throw new Error('Metadata proof exceeds bound');
  uniqueJSON(raw.toString('utf8'));
  return JSON.parse(raw.toString('utf8')) as CoreMetadataProof;
}
