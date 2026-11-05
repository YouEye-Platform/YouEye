import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomically } from '../bridges/atomic-json-store';
import { AppUpdateExecutorLock } from './update-executor-lock';
import { uniqueJSON } from '../releases/core-release';
import {
  acceptProductSequence, installedProductProjection, productReceipt, verifyInstalledProductReceipt,
  type InstalledProductReceipt, type ProductSequenceFloors, type VerifiedProductRelease,
} from '../releases/product-release';
import { parseMarketRepoURL, type MarketSource } from './source';

const DIRECTORY = '/var/lib/youeye/market-releases';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type CatalogSnapshot = { apiVersion: string; catalog: { sha256: string }; content: { files: {path: string; sha256: string}[] } };
type StoredCatalog = {
  schema: 'youeye.installed-catalog.v1'; tag: string; receipt: InstalledProductReceipt;
  snapshotBase64: string; catalog: string; floors: ProductSequenceFloors;
};
export type AcceptedCatalog = { selected: VerifiedProductRelease; snapshot: CatalogSnapshot; catalog: string; floors: ProductSequenceFloors };
const sourceKey = (source: MarketSource) => sha(`${source.repo_url}\0${source.branch}`);

/** Relative dependencies belong to the authenticated build's repository host,
 * not the host carrying a later release label. Catalog-local files still use
 * the selected transport and their exact signed content hashes.
 */
export function catalogDependencySource(source: MarketSource, accepted: AcceptedCatalog | null): MarketSource {
  if (!accepted || accepted.selected.build.source === source.repo_url) return source;
  return parseMarketRepoURL(accepted.selected.build.source, {
    id: source.id, name: source.name, branch: accepted.selected.build.branch,
    enabled: source.enabled, priority: source.priority,
  });
}

export async function resolveCatalogDependencySource(source: MarketSource): Promise<MarketSource> {
  return catalogDependencySource(source, await readAcceptedCatalog(source));
}

export function verifyCatalogSnapshot(selected: VerifiedProductRelease, raw: Buffer): CatalogSnapshot {
  if (selected.release.product !== 'market' || selected.build.kind !== 'catalog'
    || raw.length > 1024 * 1024 || sha(raw) !== selected.build.contract_sha256) throw new Error('Market snapshot differs from signed build');
  uniqueJSON(raw.toString('utf8'));
  const snapshot = JSON.parse(raw.toString('utf8')) as CatalogSnapshot;
  if (snapshot.apiVersion !== 'youeye.market/catalog-snapshot/v1' || !/^sha256:[0-9a-f]{64}$/.test(snapshot.catalog?.sha256)
    || !Array.isArray(snapshot.content?.files) || snapshot.content.files.length > 10000) throw new Error('Invalid Market snapshot');
  const names = new Set<string>();
  for (const file of snapshot.content.files) {
    if (typeof file.path !== 'string' || !/^[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(file.path)
      || !/^sha256:[0-9a-f]{64}$/.test(file.sha256)) throw new Error('Invalid Market snapshot member');
    names.add(file.path);
  }
  if (snapshot.content.files.find(f => f.path === 'catalog.yaml')?.sha256 !== snapshot.catalog.sha256) throw new Error('Market catalog binding is missing');
  return snapshot;
}

export function verifyCatalogFile(snapshot: CatalogSnapshot, filename: string, bytes: string | Buffer): void {
  const file = snapshot.content.files.find(f => f.path === filename);
  if (!file || file.sha256 !== `sha256:${sha(bytes)}`) throw new Error('Market file differs from signed catalog snapshot');
}

export async function readAcceptedCatalog(source: MarketSource, directory = DIRECTORY): Promise<AcceptedCatalog | null> {
  let file;
  try { file = await open(path.join(directory, `${sourceKey(source)}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 8 * 1024 * 1024) throw new Error('Invalid installed Market receipt file');
    const saved = JSON.parse(await file.readFile('utf8')) as StoredCatalog;
    if (saved.schema !== 'youeye.installed-catalog.v1') throw new Error('Unsupported installed Market receipt');
    const selected = verifyInstalledProductReceipt(saved.receipt, {product:'market',source:source.repo_url,tag:saved.tag});
    if (selected.release.branch !== source.branch) throw new Error('Market receipt belongs to a different channel');
    const snapshot = verifyCatalogSnapshot(selected, Buffer.from(saved.snapshotBase64, 'base64'));
    verifyCatalogFile(snapshot, 'catalog.yaml', saved.catalog);
    if (!saved.floors?.[sourceKey(source)] || saved.floors[sourceKey(source)].sequence !== selected.release.sequence
      || saved.floors[sourceKey(source)].manifestSHA256 !== selected.manifestSHA256) throw new Error('Installed Market replay floor is missing or inconsistent');
    acceptProductSequence(saved.floors, selected);
    return {selected,snapshot,catalog:saved.catalog,floors:saved.floors};
  } finally { await file.close(); }
}

/** One durable file commits the accepted label, catalog bytes and replay floor. */
export async function acceptCatalogRelease(source: MarketSource, selected: VerifiedProductRelease, snapshotBytes: Buffer, catalog: string, directory = DIRECTORY): Promise<void> {
  // Recheck trust at adoption, not just discovery (including revocation).
  selected = verifyInstalledProductReceipt(productReceipt(selected), {product:'market',source:source.repo_url,tag:selected.release.tag});
  if (selected.release.branch !== source.branch) throw new Error('Market release belongs to another channel');
  const snapshot = verifyCatalogSnapshot(selected, snapshotBytes);
  verifyCatalogFile(snapshot, 'catalog.yaml', catalog);
  if (Buffer.byteLength(catalog) > 4 * 1024 * 1024) throw new Error('Market catalog exceeds retained limit');
  await mkdir(directory, {recursive:true,mode:0o700});
  const lock = AppUpdateExecutorLock.acquire(path.join(directory, `${sourceKey(source)}.lock`));
  try {
    const prior = await readAcceptedCatalog(source, directory);
    const floors = acceptProductSequence(prior?.floors, selected);
    lock.assertHeld();
    await writeJsonAtomically(path.join(directory, `${sourceKey(source)}.json`), {
      schema:'youeye.installed-catalog.v1',tag:selected.release.tag,receipt:productReceipt(selected),
      snapshotBase64:snapshotBytes.toString('base64'),catalog,floors,
    } satisfies StoredCatalog);
  } finally { lock.release(); }
}

export async function discoverCatalogRelease(source: MarketSource): Promise<VerifiedProductRelease | null> {
  if (/^[0-9a-f]{40}$/.test(source.branch)) return null; // Owner's exact source pin.
  const {listInfrastructureReleases,selectInfrastructureStandaloneRelease} = await import('../infrastructure/release-resolver');
  const {resolveMarketProductRelease} = await import('./native-artifact');
  const releases = await listInfrastructureReleases(source,source.repository);
  const candidate = selectInfrastructureStandaloneRelease(source,releases,'catalog',source.branch);
  if (!candidate) {
    if (await readAcceptedCatalog(source)) throw new Error('Signed Market channel no longer advertises its release');
    return null; // Legacy/custom catalogs retain their existing Git path.
  }
  const selected = await resolveMarketProductRelease('market',source.repo_url,candidate.tag);
  if (!selected || selected.release.branch !== source.branch || selected.build.kind !== 'catalog') throw new Error('Selected Market release has no matching catalog contract');
  return selected;
}

export async function catalogReleaseDisplay(source: MarketSource) {
  const accepted = await readAcceptedCatalog(source);
  return accepted ? installedProductProjection(accepted.selected) : null;
}
