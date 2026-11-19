import { createHash } from 'node:crypto';
import { compareLines, compareReleases, compareVersions, isBuildName, parseReleaseVersion, releaseKey, releaseLine, validReleaseKey, type ReleaseKey } from '../version';
import { canonicalReleaseRepository, RELEASE_READER, ReleaseNeedsNewerReader, releaseAssetURL, uniqueJSON, validAssetName, validSourceTree, type CoreBlob } from './core-release';

/**
 * Unsigned product release documents (`youeye.product-release.v1`, authority
 * `digest`). The document is host-independent: the same bytes are published
 * on every host and channel. The box finds it through its channel index entry
 * (repository + tag + document digest); it embeds the immutable build
 * document, which binds every asset by SHA-256 and size. Assets are located
 * with `releaseAssetURL` (under the index entry's download base when it names one).
 * Unknown fields are ignored; a higher `minimum_reader` is `ReleaseNeedsNewerReader`.
 * Both shapes are read: old documents (`minimum_reader: 1`, the build manifest
 * names its `build_version`) and new ones (`minimum_reader: 2`, no build name).
 * Releases are ordered by line and `sequence`, never by name.
 */

export type ProductBuild = {
  schema: 'youeye.product-build.v1'; product: string; kind: 'native' | 'source';
  /** Old shape only: the build name. Validated when present; ordering never uses it. */
  build_version?: string; source_tree: string;
  input_sha256: string; contract_sha256: string; primary: string; assets: CoreBlob[];
};
export type ProductRelease = {
  schema: 'youeye.product-release.v1'; product: string; version: string; tag: string; source_tree: string;
  sequence: number; minimum_reader: number; authority: 'digest'; build_manifest_base64: string;
};
/** A verified document plus where it was found (from the channel index). */
export type VerifiedProductRelease = {
  release: ProductRelease; build: ProductBuild; manifestSHA256: string; raw: Buffer; repository: string; downloadBase?: string;
};
export type ProductReleaseExpectation = { product: string; repository: string; tag: string; downloadBase?: string };
/** Exact accepted bytes and where they came from, persisted with the protected install record. */
export type InstalledProductReceipt = {
  manifestBase64: string; manifestSHA256: string; repository: string;
};

export const PRODUCTS = ['pointer', 'canvas', 'cinema', 'notes', 'search', 'translate', 'weather', 'wiki'] as const;
const products = new Set<string>(PRODUCTS);
const hash = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const digest = (raw: Buffer) => createHash('sha256').update(raw).digest('hex');

/** `v<version>`. The tag never names a channel. */
export function productTag(version: string) {
  return `v${version}`;
}
function productTagVersion(tag: string): string | null {
  return tag.startsWith('v') && parseReleaseVersion(tag.slice(1)) ? tag.slice(1) : null;
}
function object(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid product metadata object');
}
function document(raw: Buffer): unknown {
  if (!raw.length || raw.length > 1024*1024) throw new Error('Product metadata size is invalid');
  uniqueJSON(raw.toString('utf8')); return JSON.parse(raw.toString('utf8'));
}
export function parseProductBuild(raw: Buffer): ProductBuild {
  const b = document(raw) as ProductBuild;
  object(b);
  if (b.schema !== 'youeye.product-build.v1' || !products.has(b.product) || b.build_version !== undefined && (typeof b.build_version !== 'string' || !parseReleaseVersion(b.build_version)) || !validSourceTree(b.source_tree)
    || !hash(b.input_sha256) || !hash(b.contract_sha256) || !['native','source'].includes(b.kind)) throw new Error('Invalid immutable product build');
  if (!Array.isArray(b.assets) || !b.assets.length || b.assets.length > 32) throw new Error('Invalid product asset set');
  const names = new Set<string>();
  for (const a of b.assets) {
    object(a);
    if (!validAssetName(a.name) || names.has(a.name) || !hash(a.sha256) || !Number.isSafeInteger(a.size_bytes) || a.size_bytes <= 0
      || a.release !== undefined && !productTagVersion(a.release)) throw new Error('Invalid original product asset');
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
  object(r);
  if (r.schema === 'youeye.product-release.v1' && Number.isSafeInteger(r.minimum_reader) && r.minimum_reader > RELEASE_READER) {
    throw new ReleaseNeedsNewerReader(`Product release needs reader ${r.minimum_reader}`);
  }
  if (r.schema !== 'youeye.product-release.v1' || r.authority !== 'digest' || !products.has(r.product) || !parseReleaseVersion(r.version)
    || r.tag !== productTag(r.version) || !validSourceTree(r.source_tree) || !Number.isSafeInteger(r.minimum_reader) || r.minimum_reader < 1
    || !Number.isSafeInteger(r.sequence) || r.sequence < 1) throw new Error('Invalid product release identity');
  const build = parseProductBuild(base64(r.build_manifest_base64,1024*1024));
  if (build.product !== r.product || build.source_tree !== r.source_tree) throw new Error('Product release references another build');
  return {release:r,build};
}
/** Bind the document to the repository and tag the channel index named. */
export function verifyProductRelease(raw: Buffer, expected: ProductReleaseExpectation): VerifiedProductRelease {
  const {release:r,build} = parseProductRelease(raw);
  const repository = canonicalReleaseRepository(expected.repository);
  if (repository !== expected.repository) throw new Error('Product repository is not canonical');
  if (r.product !== expected.product || r.tag !== expected.tag) throw new Error('Product release differs from selected product/tag');
  return {release:r,build,manifestSHA256:digest(raw),raw,repository,...(expected.downloadBase ? {downloadBase:expected.downloadBase} : {})};
}
export function productReceipt(selected: VerifiedProductRelease): InstalledProductReceipt {
  return {manifestBase64:selected.raw.toString('base64'), manifestSHA256:selected.manifestSHA256, repository:selected.repository};
}
export function verifyInstalledProductReceipt(receipt: InstalledProductReceipt, expected: {product: string}): VerifiedProductRelease {
  const raw = base64(receipt.manifestBase64,1024*1024);
  const {release} = parseProductRelease(raw);
  const selected = verifyProductRelease(raw,{product:expected.product,repository:receipt.repository,tag:release.tag});
  if (selected.manifestSHA256 !== receipt.manifestSHA256) throw new Error('Installed product receipt digest differs');
  return selected;
}
/** The installed release a receipt records, or null when there is none or it is unreadable (never throws). */
export function installedProductRelease(receipt: InstalledProductReceipt | null | undefined, product: string): VerifiedProductRelease | null {
  if (!receipt) return null;
  try { return verifyInstalledProductReceipt(receipt, {product}); } catch { return null; }
}
/** Where one asset of a verified release is downloaded. */
export function productAssetURL(selected: VerifiedProductRelease, blob: CoreBlob): string {
  if (!selected.build.assets.includes(blob)) throw new Error('Foreign product asset');
  return releaseAssetURL(selected.repository, selected.release.tag, blob, selected.downloadBase);
}
export function identicalProductPayloads(before: VerifiedProductRelease, after: VerifiedProductRelease): boolean {
  return before.release.product === after.release.product && before.release.build_manifest_base64 === after.release.build_manifest_base64;
}

/** SHA-256 of the embedded build manifest: one build, whatever release names it. */
export function productBuildSHA256(selected: VerifiedProductRelease): string {
  return digest(Buffer.from(selected.release.build_manifest_base64,'base64'));
}

export function installedProductProjection(selected: VerifiedProductRelease) {
  return {schema:'youeye.installed-product.v1',product:selected.release.product,version:selected.release.version,
    ...(selected.build.build_version ? {build_version:selected.build.build_version} : {}),
    source_tree:selected.release.source_tree,release_sha256:selected.manifestSHA256,
    build_sha256:productBuildSHA256(selected)};
}

/** The order key of a verified release: its line and sequence. */
export function productReleaseKey(selected: VerifiedProductRelease): ReleaseKey {
  return releaseKey(selected.release);
}

/**
 * Replay floor per product: a box never accepts an older release of a product
 * than the one it already runs (this is also the no-downgrade rule when the
 * box's channel changes; it waits for the channel to catch up).
 *
 * Releases are ordered by line, then sequence (`compareReleases`); names are
 * labels. `buildSHA256` identifies the accepted build; `manifestSHA256` is the
 * release document last accepted for it.
 *
 * Two shapes (Plan 12, decision 8): `line` and `sequence` are the key; `build`
 * is the old shape (a 0.6.11 Control Panel orders by it and requires it).
 * Until the Release cleanup both are written. A floor written before 0.6.12
 * has no `sequence`: it is taken from the installed release document when that
 * is the document the floor names, else the old build rule decides within one
 * line.
 */
export type ProductReleaseFloor = {line?: string; sequence?: number; build?: string; buildSHA256: string; manifestSHA256: string};
export type ProductSequenceFloors = Record<string,ProductReleaseFloor>;
export function validProductFloor(floor: unknown): floor is ProductReleaseFloor {
  const f = floor as ProductReleaseFloor | undefined;
  if (!f || typeof f !== 'object' || !hash(f.buildSHA256) || !hash(f.manifestSHA256)) return false;
  const keyed = f.line !== undefined || f.sequence !== undefined;
  if (keyed && !validReleaseKey({line:f.line,sequence:f.sequence})) return false;
  if (f.build !== undefined && (typeof f.build !== 'string' || !parseReleaseVersion(f.build))) return false;
  return keyed || f.build !== undefined;
}
/** The floor's key: recorded, or (an older floor) from the installed document it names; null when neither has one. */
function floorKey(floor: ProductReleaseFloor, installed?: VerifiedProductRelease | null): ReleaseKey | null {
  if (floor.line !== undefined && floor.sequence !== undefined) return {line:floor.line,sequence:floor.sequence};
  if (installed && installed.manifestSHA256 === floor.manifestSHA256) return productReleaseKey(installed);
  return null;
}
/**
 * Order of the selected release against a floor: <0 older, 0 the same build,
 * >0 newer. Throws on other contents under the same key. `installed` is the
 * installed release document, used to read an older floor's sequence.
 */
export function compareToProductFloor(floor: ProductReleaseFloor, selected: VerifiedProductRelease, installed?: VerifiedProductRelease | null): number {
  const key = floorKey(floor, installed);
  let order: number;
  if (key) order = compareReleases(selected.release, key);
  else {
    // An older floor (build only): lines first. Within one line the old build rule orders two build names only
    // (`-dev.N`); a release name (`-beta.1`, `0.6.4`) is a label, never ordered against a build. A document without
    // a build name has the new shape, which was published after every old-shape build: newer, unless it holds the
    // floor's own build.
    const built = selected.build.build_version;
    order = compareLines(selected.release.version, releaseLine(floor.build!)!);
    if (order === 0) {
      if (isBuildName(built) && isBuildName(floor.build)) order = compareVersions(built, floor.build);
      else if (productBuildSHA256(selected) !== floor.buildSHA256) order = built === undefined ? 1 : -1;
    }
  }
  if (order === 0 && productBuildSHA256(selected) !== floor.buildSHA256) {
    throw new Error(`The channel offers ${selected.release.product} ${selected.release.version} with other contents than the installed release of the same build`);
  }
  return order;
}
/** The floor after accepting `selected`, in both shapes (see ProductReleaseFloor). */
export function productReleaseFloor(selected: VerifiedProductRelease): ProductReleaseFloor {
  const {line, sequence} = productReleaseKey(selected);
  return {line, sequence, build:selected.build.build_version ?? selected.release.version, buildSHA256:productBuildSHA256(selected), manifestSHA256:selected.manifestSHA256};
}
export function acceptProductSequence(floors: ProductSequenceFloors | undefined, selected: VerifiedProductRelease, installed?: VerifiedProductRelease | null): ProductSequenceFloors {
  const r = selected.release;
  const previous = floors?.[r.product];
  if (previous && !validProductFloor(previous)) throw new Error('Invalid installed product sequence floor');
  // The same build under another release name (a promotion) is not older;
  // accepting it only changes the release document.
  if (previous && compareToProductFloor(previous, selected, installed) < 0) {
    // Versions only: the installed release's name when the floor is that release, else the floor's line (never a build name).
    const key = floorKey(previous, installed);
    const has = installed && key && compareReleases(installed.release, key) === 0 ? installed.release.version : key?.line ?? releaseLine(previous.build!);
    throw new Error(`The channel offers ${r.product} ${r.version}; this box has ${has}; waiting for the channel to catch up`);
  }
  return {...floors,[r.product]:productReleaseFloor(selected)};
}

const megabytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));

/** The named asset of a verified release, refused when it is missing or larger than `maximumBytes`. */
export function productBlobWithinLimit(selected: VerifiedProductRelease, name: string, maximumBytes: number): CoreBlob {
  const blob = selected.build.assets.find(a => a.name === name);
  if (!blob) throw new Error(`Release ${selected.release.tag} has no ${name} asset`);
  if (blob.size_bytes > maximumBytes) {
    throw new Error(`Release ${selected.release.tag} package ${name} (${megabytes(blob.size_bytes)} MB) is larger than the limit (${megabytes(maximumBytes)} MB)`);
  }
  return blob;
}

/** Download one named asset of a verified release and check its digest and size. */
export async function loadProductBlob(selected: VerifiedProductRelease, name: string,
  load: (url: string, maximumBytes: number) => Promise<Buffer>, maximumBytes: number): Promise<Buffer> {
  const blob = productBlobWithinLimit(selected, name, maximumBytes);
  const bytes = await load(productAssetURL(selected,blob),blob.size_bytes);
  if (bytes.length !== blob.size_bytes || digest(bytes) !== blob.sha256) throw new Error('Product artifact differs from its original build digest');
  return bytes;
}
