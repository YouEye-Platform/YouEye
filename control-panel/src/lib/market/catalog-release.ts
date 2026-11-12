import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomically } from '../bridges/atomic-json-store';
import { AppUpdateExecutorLock } from './update-executor-lock';
import { uniqueJSON } from '../releases/core-release';
import { downloadProductAsset, resolveChannelProduct } from '../releases/channel-index';
import {
  acceptProductSequence, installedProductProjection, productBuildSHA256, productReceipt, verifyInstalledProductReceipt,
  type InstalledProductReceipt, type ProductSequenceFloors, type VerifiedProductRelease,
} from '../releases/product-release';

/**
 * The official Market catalog is the `market` product of the box's channel
 * index. Its release carries `catalog-snapshot.json` (the build contract),
 * `catalog.tar` (a plain tar of exactly the snapshot's files) and
 * `product-release.json`. The accepted tar is kept on disk and every catalog
 * file is served from it, each checked against the snapshot hash. There is no
 * git access, no branch and no commit for the official Market.
 */

const DIRECTORY = '/var/lib/youeye/market-releases';
const STATE = 'official.json';
const MAX_TAR_BYTES = 64 * 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export type CatalogSnapshot = { apiVersion: string; catalog: { sha256: string }; content: { files: {path: string; sha256: string}[] } };
type StoredCatalog = {
  schema: 'youeye.installed-catalog.v1'; receipt: InstalledProductReceipt; snapshotBase64: string; floors: ProductSequenceFloors;
};
export type AcceptedCatalog = {
  selected: VerifiedProductRelease; snapshot: CatalogSnapshot; files: Map<string, Buffer>; floors: ProductSequenceFloors;
};

export function verifyCatalogSnapshot(selected: VerifiedProductRelease, raw: Buffer): CatalogSnapshot {
  if (selected.release.product !== 'market' || selected.build.kind !== 'catalog'
    || raw.length > 1024 * 1024 || sha(raw) !== selected.build.contract_sha256) throw new Error('Market snapshot differs from its build digest');
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
  if (!file || file.sha256 !== `sha256:${sha(bytes)}`) throw new Error('Market file differs from the accepted catalog snapshot');
}

function octal(field: Buffer): number {
  const text = field.toString('ascii').replace(/\0[\s\S]*$/, '').trim();
  if (!/^[0-7]*$/.test(text)) throw new Error('Invalid catalog.tar header');
  return text ? parseInt(text, 8) : 0;
}

function paxPath(data: Buffer): string | undefined {
  let offset = 0, found: string | undefined;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const length = Number(data.subarray(offset, space).toString('ascii'));
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) throw new Error('Invalid catalog.tar extended header');
    const record = data.subarray(space + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (record.slice(0, equals) === 'path') found = record.slice(equals + 1);
    offset += length;
  }
  return found;
}

/**
 * Read a plain (ustar/pax/gnu) tar. Only regular files and directories are
 * allowed; every regular file must be listed in the snapshot with its hash,
 * and every snapshot file must be present exactly once.
 */
export function readCatalogTar(tar: Buffer, snapshot: CatalogSnapshot): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const expected = new Map(snapshot.content.files.map(f => [f.path, f.sha256]));
  let offset = 0, longName: string | undefined;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const stored = octal(header.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += i >= 148 && i < 156 ? 0x20 : header[i];
    if (sum !== stored) throw new Error('catalog.tar header checksum differs');
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) throw new Error('catalog.tar is truncated');
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longName = paxPath(body) ?? longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '');
    const prefix = header.subarray(257, 263).toString('ascii').startsWith('ustar') ? header.subarray(345, 500).toString('utf8').replace(/\0[\s\S]*$/, '') : '';
    const entry = (longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, '');
    longName = undefined;
    if (type === '5') continue;
    if (type !== '0') throw new Error('catalog.tar may only contain regular files and directories');
    const want = expected.get(entry);
    if (!want || files.has(entry) || want !== `sha256:${sha(body)}`) throw new Error(`catalog.tar file ${entry} differs from the catalog snapshot`);
    files.set(entry, Buffer.from(body));
  }
  if (files.size !== expected.size) throw new Error('catalog.tar does not contain every catalog snapshot file');
  return files;
}

async function readProtected(file: string, maximum: number): Promise<Buffer | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > maximum) throw new Error('Invalid installed Market file');
    return await handle.readFile();
  } finally { await handle.close(); }
}

const tarFile = (directory: string, digest: string) => path.join(directory, `catalog-${digest}.tar`);
function tarAsset(selected: VerifiedProductRelease) {
  const asset = selected.build.assets.find(a => a.name === 'catalog.tar');
  if (!asset) throw new Error('Market release has no catalog.tar');
  return asset;
}

let memory: { key: string; accepted: AcceptedCatalog } | null = null;

/** The accepted official catalog, verified from its protected files on every read. */
export async function readAcceptedCatalog(directory = DIRECTORY): Promise<AcceptedCatalog | null> {
  const raw = await readProtected(path.join(directory, STATE), 8 * 1024 * 1024);
  if (!raw) return null;
  const saved = JSON.parse(raw.toString('utf8')) as StoredCatalog;
  if (saved.schema !== 'youeye.installed-catalog.v1') throw new Error('Unsupported installed Market receipt');
  const key = `${directory}\0${sha(raw)}`;
  if (memory?.key === key) return memory.accepted;
  const selected = verifyInstalledProductReceipt(saved.receipt, {product:'market'});
  const snapshot = verifyCatalogSnapshot(selected, Buffer.from(saved.snapshotBase64, 'base64'));
  const asset = tarAsset(selected);
  const tar = await readProtected(tarFile(directory, asset.sha256), MAX_TAR_BYTES);
  if (!tar || tar.length !== asset.size_bytes || sha(tar) !== asset.sha256) throw new Error('Installed catalog.tar is missing or differs from its release');
  const floor = saved.floors?.market;
  if (!floor || floor.build !== selected.build.build_version || floor.buildSHA256 !== productBuildSHA256(selected) || floor.manifestSHA256 !== selected.manifestSHA256) throw new Error('Installed Market replay floor is missing or inconsistent');
  const accepted = {selected, snapshot, files: readCatalogTar(tar, snapshot), floors: saved.floors};
  memory = {key, accepted};
  return accepted;
}

/** One durable state file commits the accepted release, snapshot and replay floor; the tar is content-addressed. */
export async function acceptCatalogRelease(selected: VerifiedProductRelease, snapshotBytes: Buffer, tar: Buffer, directory = DIRECTORY): Promise<AcceptedCatalog> {
  const snapshot = verifyCatalogSnapshot(selected, snapshotBytes);
  const asset = tarAsset(selected);
  if (tar.length !== asset.size_bytes || sha(tar) !== asset.sha256) throw new Error('catalog.tar differs from its release digest');
  const files = readCatalogTar(tar, snapshot);
  await mkdir(directory, {recursive:true,mode:0o700});
  const lock = AppUpdateExecutorLock.acquire(path.join(directory, 'official.lock'));
  try {
    const prior = await readAcceptedCatalog(directory).catch(() => null);
    const floors = acceptProductSequence(prior?.floors, selected);
    const target = tarFile(directory, asset.sha256), staged = `${target}.tmp-${process.pid}`;
    await writeFile(staged, tar, {mode:0o600});
    await rename(staged, target);
    lock.assertHeld();
    await writeJsonAtomically(path.join(directory, STATE), {
      schema:'youeye.installed-catalog.v1', receipt:productReceipt(selected), snapshotBase64:snapshotBytes.toString('base64'), floors,
    } satisfies StoredCatalog);
    for (const name of await readdir(directory)) {
      if (/^catalog-[0-9a-f]{64}\.tar$/.test(name) && name !== path.basename(target)) await rm(path.join(directory, name), {force:true});
    }
    return {selected, snapshot, files, floors};
  } finally { lock.release(); }
}

/**
 * Bring the official catalog to the channel's `market` release. Keeps the
 * accepted catalog when the channel offers the same or an older release.
 */
export async function refreshOfficialCatalog(options: { resolve?: () => Promise<VerifiedProductRelease | null>; directory?: string } = {}): Promise<AcceptedCatalog> {
  const directory = options.directory ?? DIRECTORY;
  const accepted = await readAcceptedCatalog(directory).catch((error) => {
    console.warn('[market] Accepted official catalog is unreadable; refetching', error);
    return null;
  });
  const selected = await (options.resolve ?? (() => resolveChannelProduct('market')))();
  if (!selected) {
    if (accepted) return accepted;
    throw new Error('This channel has no Market catalog release yet');
  }
  if (selected.build.kind !== 'catalog') throw new Error('Market release is not a catalog build');
  if (accepted?.selected.manifestSHA256 === selected.manifestSHA256) return accepted;
  acceptProductSequence(accepted?.floors, selected);
  const snapshot = await downloadProductAsset(selected, 'catalog-snapshot.json');
  const tar = await downloadProductAsset(selected, 'catalog.tar', MAX_TAR_BYTES);
  return acceptCatalogRelease(selected, snapshot, tar, directory);
}

/** One file of the accepted official catalog (checked against the snapshot when it was read). */
export async function officialCatalogFile(filePath: string, directory = DIRECTORY): Promise<Buffer> {
  const accepted = await readAcceptedCatalog(directory) ?? await refreshOfficialCatalog({directory});
  const file = accepted.files.get(filePath.replace(/^\.\//, ''));
  if (!file) throw new Error(`The Market catalog has no file ${filePath}`);
  return file;
}

export async function catalogReleaseDisplay() {
  const accepted = await readAcceptedCatalog().catch(() => null);
  return accepted ? installedProductProjection(accepted.selected) : null;
}
