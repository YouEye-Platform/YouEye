import { createHash } from 'node:crypto';
import { parseReleaseVersion } from '../version';
import { canonicalReleaseRepository, uniqueJSON, validReleaseBranch, type CoreBlob } from './core-release';

/**
 * Unsigned product release documents (`youeye.product-release.v1`, authority
 * `digest`). The release document is fetched over HTTPS from the selected
 * release; it embeds the immutable build document, which binds every asset by
 * SHA-256 and size. The accepted document's own SHA-256 is the installed
 * identity and the replay-floor key.
 */

export type ProductBuild = {
  schema: 'youeye.product-build.v1'; product: string; kind: 'native' | 'source' | 'catalog';
  build_version: string; source: string; branch: string; source_commit: string; tag: string;
  asset_source?: string; asset_tag?: string;
  input_sha256: string; contract_sha256: string; primary: string; assets: CoreBlob[];
};
export type ProductRelease = {
  schema: 'youeye.product-release.v1'; product: string; version: string; source: string; branch: string;
  tag: string; channel: string; sequence: number; previous_manifest_sha256?: string; minimum_reader: 1;
  authority: 'digest'; build_manifest_base64: string;
};
export type VerifiedProductRelease = {
  release: ProductRelease; build: ProductBuild; manifestSHA256: string; raw: Buffer;
};
export type ProductReleaseExpectation = {product: string; source: string; tag: string};
/** Exact accepted bytes, persisted with the protected install record. */
export type InstalledProductReceipt = {
  manifestBase64: string; manifestSHA256: string;
};
export function productReceipt(selected: VerifiedProductRelease): InstalledProductReceipt {
  return {manifestBase64:selected.raw.toString('base64'), manifestSHA256:selected.manifestSHA256};
}
export function verifyInstalledProductReceipt(receipt: InstalledProductReceipt, expected: ProductReleaseExpectation): VerifiedProductRelease {
  const selected = verifyProductRelease(base64(receipt.manifestBase64,1024*1024),expected);
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
  fields(b,['schema','product','kind','build_version','source','branch','source_commit','tag','asset_source','asset_tag','input_sha256','contract_sha256','primary','assets']);
  if (b.schema !== 'youeye.product-build.v1' || !products.has(b.product) || !parseReleaseVersion(b.build_version) || canonicalReleaseRepository(b.source) !== b.source || !validReleaseBranch(b.branch) || !/^[0-9a-f]{40}$/.test(b.source_commit) || !hash(b.input_sha256) || !hash(b.contract_sha256) || b.tag !== productTag(b.product,b.branch,b.build_version) || !['native','source','catalog'].includes(b.kind)) throw new Error('Invalid immutable product build');
  channel(b.source,b.branch,b.build_version);
  if ((b.asset_source === undefined) !== (b.asset_tag === undefined)) throw new Error('Product asset source and tag must be paired');
  if (b.asset_source !== undefined && (canonicalReleaseRepository(b.asset_source) !== b.asset_source || !validReleaseBranch(b.asset_tag!))) throw new Error('Invalid product asset location');
  const assetSource = b.asset_source ?? b.source, assetTag = b.asset_tag ?? b.tag;
  if (!Array.isArray(b.assets) || !b.assets.length || b.assets.length > 32) throw new Error('Invalid product asset set');
  const names = new Set<string>();
  for (const a of b.assets) {
    fields(a,['name','url','sha256','size_bytes']);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(a.name) || names.has(a.name) || !hash(a.sha256) || !Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0 || a.url !== `${assetSource}/releases/download/${encodeURIComponent(assetTag)}/${a.name}`) throw new Error('Invalid original product asset');
    names.add(a.name);
  }
  if (!names.has(b.primary)) throw new Error('Missing primary product artifact');
  if (b.kind === 'native' && b.primary !== 'standalone.tar') throw new Error('Native product primary must be standalone.tar');
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
  fields(r,['schema','product','version','source','branch','tag','channel','sequence','previous_manifest_sha256','minimum_reader','authority','build_manifest_base64']);
  if (r.schema !== 'youeye.product-release.v1' || r.authority !== 'digest' || !products.has(r.product) || !parseReleaseVersion(r.version) || canonicalReleaseRepository(r.source) !== r.source || !validReleaseBranch(r.branch) || r.tag !== productTag(r.product,r.branch,r.version) || r.minimum_reader !== 1 || !Number.isSafeInteger(r.sequence) || r.sequence < 1 || r.previous_manifest_sha256 !== undefined && !hash(r.previous_manifest_sha256) || channel(r.source,r.branch,r.version) !== r.channel) throw new Error('Invalid product release identity');
  const build = parseProductBuild(base64(r.build_manifest_base64,1024*1024));
  if (build.product !== r.product) throw new Error('Product release references another product');
  return {release:r,build};
}
/** Bind the document to the selected source and tag; assets are bound by its build digests. */
export function verifyProductRelease(raw: Buffer, expected: ProductReleaseExpectation): VerifiedProductRelease {
  const {release:r,build} = parseProductRelease(raw);
  if (r.product !== expected.product || r.source !== expected.source || r.tag !== expected.tag) throw new Error('Product release differs from selected source/tag');
  return {release:r,build,manifestSHA256:digest(raw),raw};
}
export class ProductAssetNotFound extends Error {}
export function productBlobTransportURL(selected: VerifiedProductRelease, blob: CoreBlob, mirror = false): string {
  if (!selected.build.assets.some(a => a.url === blob.url && a.sha256 === blob.sha256 && a.size_bytes === blob.size_bytes && a.name === blob.name)) throw new Error('Foreign product transport blob');
  if (mirror || selected.release.source !== selected.build.source) return `${selected.release.source}/releases/download/${selected.release.tag}/blob-${blob.sha256}`;
  return blob.url;
}
export function identicalProductPayloads(before: VerifiedProductRelease, after: VerifiedProductRelease): boolean {
  return before.release.product === after.release.product && before.release.build_manifest_base64 === after.release.build_manifest_base64;
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
  assetNames: string[], expected: ProductReleaseExpectation,
  load: (name: string, maximumBytes: number) => Promise<Buffer>,
): Promise<VerifiedProductRelease | null> {
  const count = assetNames.filter(name => name === 'product-release.json').length;
  if (!count) return null;
  if (count !== 1) throw new Error('Ambiguous product release document');
  return verifyProductRelease(await load('product-release.json',1024*1024),expected);
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
  if (bytes.length !== blob.size_bytes || digest(bytes) !== blob.sha256) throw new Error('Product artifact differs from its original build digest');
  return bytes;
}
