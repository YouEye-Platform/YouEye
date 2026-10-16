import { createHash, createPublicKey, verify } from 'node:crypto';
import { parseReleaseVersion } from '../version';
import { canonicalTrustRepository, validTrustBranch, type TrustScope } from './owner-trust';
import { uniqueJSON, type CoreBlob } from './core-release';
import { releaseArtifactTrust } from './verify';

export type ProductBuild = {
  schema: 'youeye.product-build.v1'; product: string; kind: 'native' | 'source' | 'catalog';
  build_version: string; source: string; branch: string; source_commit: string; tag: string;
  input_sha256: string; contract_sha256: string; signer_sha256: string; primary: string; assets: CoreBlob[];
};
export type ProductRelease = {
  schema: 'youeye.product-release.v1'; product: string; version: string; source: string; branch: string;
  tag: string; channel: string; sequence: number; previous_manifest_sha256?: string; minimum_reader: 1;
  signer_sha256: string; build_manifest_base64: string; build_signature_base64: string;
};
export type VerifiedProductRelease = {
  release: ProductRelease; build: ProductBuild; manifestSHA256: string; raw: Buffer; signature: Buffer;
};
/** Exact signed bytes, persisted with the protected install record. */
export type InstalledProductReceipt = {
  manifestBase64: string; signatureBase64: string; manifestSHA256: string;
};
export function productReceipt(selected: VerifiedProductRelease): InstalledProductReceipt {
  return {manifestBase64:selected.raw.toString('base64'), signatureBase64:selected.signature.toString('base64'), manifestSHA256:selected.manifestSHA256};
}
export function verifyInstalledProductReceipt(receipt: InstalledProductReceipt, expected: Parameters<typeof verifyProductRelease>[2]): VerifiedProductRelease {
  const selected = verifyProductRelease(base64(receipt.manifestBase64,1024*1024),base64(receipt.signatureBase64,64),expected);
  if (selected.manifestSHA256 !== receipt.manifestSHA256) throw new Error('Installed product receipt digest differs');
  return selected;
}
const products = new Set(['pointer','market','canvas','cinema','notes','search','translate','weather','wiki']);
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');
export function productTag(product: string, branch: string, version: string) {
  return `${product === 'market' ? 'catalog-' : ''}${branch === 'main' ? '' : branch + '-'}v${version}`;
}
function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported product metadata fields');
}
function document(raw: Buffer): unknown {
  if (!raw.length || raw.length > 1024*1024) throw new Error('Product metadata size is invalid');
  uniqueJSON(raw.toString('utf8')); return JSON.parse(raw.toString('utf8'));
}
function channel(source: string, branch: string, version: string): string {
  const parsed = parseReleaseVersion(version);
  if (!parsed) throw new Error('Invalid product build version');
  if (source.startsWith('https://github.com/')) {
    if (branch === 'main' && !parsed.token) return 'stable';
    if (branch === 'beta' && parsed.token === 'beta') return 'beta';
    throw new Error('Public product has no scoped original authority');
  }
  if (branch === 'main' && parsed.token === 'alpha') return 'alpha';
  if (branch === 'dev' && parsed.token === 'dev') return 'dev';
  return 'feature';
}
export function parseProductBuild(raw: Buffer): ProductBuild {
  const b = document(raw) as ProductBuild;
  fields(b,['schema','product','kind','build_version','source','branch','source_commit','tag','input_sha256','contract_sha256','signer_sha256','primary','assets']);
  if (b.schema !== 'youeye.product-build.v1' || !products.has(b.product) || !parseReleaseVersion(b.build_version) || canonicalTrustRepository(b.source) !== b.source || !validTrustBranch(b.branch) || !/^[0-9a-f]{40}$/.test(b.source_commit) || !hash(b.input_sha256) || !hash(b.contract_sha256) || !hash(b.signer_sha256) || b.tag !== productTag(b.product,b.branch,b.build_version) || !['native','source','catalog'].includes(b.kind)) throw new Error('Invalid immutable product build');
  channel(b.source,b.branch,b.build_version);
  if (!Array.isArray(b.assets) || !b.assets.length || b.assets.length > 32) throw new Error('Invalid product asset set');
  const names = new Set<string>();
  for (const a of b.assets) {
    fields(a,['name','url','sha256','size_bytes']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.name) || names.has(a.name) || !hash(a.sha256) || !Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0 || a.url !== `${b.source}/releases/download/${b.tag}/${a.name}`) throw new Error('Invalid original product asset');
    names.add(a.name);
  }
  if (!names.has(b.primary)) throw new Error('Missing primary product artifact');
  if (b.kind === 'native' && (b.primary !== 'standalone.tar' || ['standalone.tar','SHA256SUMS','SHA256SUMS.sig','provenance.json','sbom.spdx.json'].some(n => !names.has(n)))) throw new Error('Incomplete native product envelope');
  return b;
}
function base64(value: string, maximum: number): Buffer {
  if (typeof value !== 'string' || value.length > Math.ceil(maximum/3)*4) throw new Error('Product encoding exceeds bounds');
  const raw = Buffer.from(value,'base64');
  if (raw.toString('base64') !== value || raw.length > maximum) throw new Error('Invalid product metadata encoding');
  return raw;
}
export function parseProductRelease(raw: Buffer) {
  const r = document(raw) as ProductRelease;
  fields(r,['schema','product','version','source','branch','tag','channel','sequence','previous_manifest_sha256','minimum_reader','signer_sha256','build_manifest_base64','build_signature_base64']);
  if (r.schema !== 'youeye.product-release.v1' || !products.has(r.product) || !parseReleaseVersion(r.version) || canonicalTrustRepository(r.source) !== r.source || !validTrustBranch(r.branch) || r.tag !== productTag(r.product,r.branch,r.version) || r.minimum_reader !== 1 || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || !hash(r.signer_sha256) || r.previous_manifest_sha256 !== undefined && !hash(r.previous_manifest_sha256) || channel(r.source,r.branch,r.version) !== r.channel) throw new Error('Invalid product release identity');
  const buildRaw = base64(r.build_manifest_base64,1024*1024), buildSignature = base64(r.build_signature_base64,64);
  if (buildSignature.length !== 64) throw new Error('Invalid original build signature');
  const build = parseProductBuild(buildRaw);
  if (build.product !== r.product || ['stable','beta'].includes(r.channel) && build.source !== r.source) throw new Error('Product release references a private or foreign build');
  return {release:r,build,buildRaw,buildSignature};
}
export function verifyProductRelease(raw: Buffer, signature: Buffer, expected: {product: string; source: string; tag: string; scope?: TrustScope}): VerifiedProductRelease {
  const {release:r,build,buildRaw,buildSignature} = parseProductRelease(raw);
  if (r.product !== expected.product || r.source !== expected.source || r.tag !== expected.tag) throw new Error('Product release differs from selected source/tag');
  for (const [bytes,sig,source,tag,signer] of [[raw,signature,r.source,r.tag,r.signer_sha256],[buildRaw,buildSignature,build.source,build.tag,build.signer_sha256]] as const) {
    const trust = releaseArtifactTrust(`${source}/releases/download/${tag}/product-release.json`,undefined,expected.scope || 'app');
    const key = createPublicKey(trust.pem);
    if (digest(key.export({type:'spki',format:'der'})) !== signer || sig.length !== 64 || !verify(null,bytes,key,sig)) throw new Error('Product release/build signature rejected');
  }
  return {release:r,build,manifestSHA256:digest(raw),raw,signature};
}
export class ProductAssetNotFound extends Error {}
export function productBlobTransportURL(selected: VerifiedProductRelease, blob: CoreBlob, mirror = false): string {
  if (!selected.build.assets.some(a => a.url === blob.url && a.sha256 === blob.sha256 && a.size_bytes === blob.size_bytes && a.name === blob.name)) throw new Error('Foreign product transport blob');
  if (mirror || new URL(selected.release.source).hostname !== 'github.com' && new URL(blob.url).hostname === 'github.com') return `${selected.release.source}/releases/download/${selected.release.tag}/blob-${blob.sha256}`;
  return blob.url;
}
export function identicalProductPayloads(before: VerifiedProductRelease, after: VerifiedProductRelease): boolean {
  return before.release.product === after.release.product && before.release.build_manifest_base64 === after.release.build_manifest_base64 && before.release.build_signature_base64 === after.release.build_signature_base64;
}

export function installedProductProjection(selected: VerifiedProductRelease) {
  return {schema:'youeye.installed-product.v1',product:selected.release.product,version:selected.release.version,
    channel:selected.release.channel,build_version:selected.build.build_version,release_sha256:selected.manifestSHA256,
    build_sha256:digest(Buffer.from(selected.release.build_manifest_base64,'base64'))};
}

export type ProductSequenceFloors = Record<string,{source:string;branch:string;sequence:number;manifestSHA256:string}>;
export function acceptProductSequence(floors: ProductSequenceFloors | undefined, selected: VerifiedProductRelease): ProductSequenceFloors {
  const {release:r,manifestSHA256} = selected;
  const key = digest(Buffer.from(`${r.source}\0${r.branch}`));
  const previous = floors?.[key];
  if (previous && (previous.source !== r.source || previous.branch !== r.branch || !Number.isSafeInteger(previous.sequence) || previous.sequence < 1 || !hash(previous.manifestSHA256))) throw new Error('Invalid installed product sequence floor');
  if (previous && (r.sequence < previous.sequence || r.sequence === previous.sequence && manifestSHA256 !== previous.manifestSHA256)) throw new Error('Product release sequence rollback or substitution rejected');
  return {...floors,[key]:{source:r.source,branch:r.branch,sequence:r.sequence,manifestSHA256}};
}

/** The resolver supplies only the selected release's validated asset transport. */
export async function loadProductRelease(
  assetNames: string[], expected: Parameters<typeof verifyProductRelease>[2],
  load: (name: string, maximumBytes: number) => Promise<Buffer>,
): Promise<VerifiedProductRelease | null> {
  const names = ['product-release.json','product-release.json.sig'];
  if (!names.some(name => assetNames.includes(name))) return null;
  if (names.some(name => assetNames.filter(n => n === name).length !== 1)) throw new Error('Incomplete product release signature');
  const [raw,signature] = await Promise.all([load(names[0],1024*1024),load(names[1],64)]);
  return verifyProductRelease(raw,signature,expected);
}

export async function loadProductBlob(selected: VerifiedProductRelease, name: string,
  load: (url: string, maximumBytes: number) => Promise<Buffer>, maximumBytes: number): Promise<Buffer> {
  const blob = selected.build.assets.find(a => a.name === name);
  if (!blob || blob.size_bytes > maximumBytes) throw new Error('Missing or oversized original product asset');
  const primary = productBlobTransportURL(selected,blob), mirror = productBlobTransportURL(selected,blob,true);
  let bytes: Buffer;
  try { bytes = await load(primary,blob.size_bytes); }
  catch (error) {
    if (!(error instanceof ProductAssetNotFound) || primary === mirror) throw error;
    bytes = await load(mirror,blob.size_bytes);
  }
  if (bytes.length !== blob.size_bytes || digest(bytes) !== blob.sha256) throw new Error('Product artifact differs from signed original build');
  return bytes;
}
