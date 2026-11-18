/**
 * The Market's own state in the core backup: the market sources the owner added (with their acceptance) and the apps
 * added by URL (with the manifest the owner agreed to). Without them a restored box loses both: its installed apps
 * then have no update source.
 *
 * - The files are copied into the backup's staging folder under `market/` (the archive is the whole folder). The
 *   backup's record (`backup-meta.json`) lists which of them it holds, in `marketFiles`; an empty list means the box
 *   had none, and a restore then removes the target's.
 * - A backup made before this (no `marketFiles`) restores as before: the target's Market files stay as they are.
 * - What a market holds (`/var/lib/youeye/markets/**`) is not backed up: a box reads it again from the markets.
 */
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import path from 'path';

/** The Market files a core backup carries, by their name in the backup's `market/` folder. */
export const MARKET_BACKUP_FILES = {
  'market-sources.json': 'market-sources.json',
  'direct-market-apps.json': path.join('state', 'direct-market-apps.json'),
} as const;

export type MarketBackupFile = keyof typeof MARKET_BACKUP_FILES;

/** Larger than any real file (a few KB of sources; the Added apps' manifests and setup files at most a few MB). */
const MAX_MARKET_FILE_BYTES = 32 * 1024 * 1024;

const MARKET_DIRECTORY = 'market';
const DEFAULT_DATA_ROOT = '/var/lib/youeye';

const isMarketBackupFile = (name: unknown): name is MarketBackupFile =>
  typeof name === 'string' && Object.hasOwn(MARKET_BACKUP_FILES, name);

/** A Market file's place on the box. */
export function marketFilePath(name: MarketBackupFile, dataRoot = DEFAULT_DATA_ROOT): string {
  return path.join(dataRoot, MARKET_BACKUP_FILES[name]);
}

/**
 * Copy the box's Market files into `stagingDir/market/`. Returns the names copied (for `marketFiles`); a file the box
 * does not have is left out (a box that never added a source has neither). Throws for a file a restore would refuse
 * (`marketFileProblem`), except an Added-app store without apps (`{}`, `null`, `entries: null`, …), which the Market
 * reads as empty: it is backed up as the empty store.
 */
export async function stageMarketState(stagingDir: string, dataRoot = DEFAULT_DATA_ROOT): Promise<MarketBackupFile[]> {
  const staged: MarketBackupFile[] = [];
  for (const name of Object.keys(MARKET_BACKUP_FILES) as MarketBackupFile[]) {
    const source = marketFilePath(name, dataRoot);
    const info = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) continue;
    if (!info.isFile()) throw new Error(`Refusing to back up ${MARKET_BACKUP_FILES[name]}: it is not a plain file`);
    if (info.size > MAX_MARKET_FILE_BYTES) throw new Error(`Refusing to back up ${MARKET_BACKUP_FILES[name]}: it is too large`);
    let bytes = await readFile(source);
    // An Added-app store the Market reads as holding no apps is backed up as the empty store its writer makes.
    if (name === 'direct-market-apps.json' && marketFileProblem(name, bytes) && holdsNoDirectApps(bytes)) {
      bytes = Buffer.from(EMPTY_DIRECT_APP_STORE);
    }
    // A backup holds only what a restore takes: a file it would refuse fails the backup now, not the restore later.
    const problem = marketFileProblem(name, bytes);
    if (problem) throw new Error(`Refusing to back up ${MARKET_BACKUP_FILES[name]}: ${problem}`);
    const directory = path.join(stagingDir, MARKET_DIRECTORY);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = path.join(directory, name);
    await writeFile(destination, bytes, { mode: 0o600 });
    await chmod(destination, 0o600);
    staged.push(name);
  }
  return staged;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The Added-app store's shape (`DirectMarketAppStore` in lib/market/direct-apps.ts): `schemaVersion: 1` and an
 * `entries` object of objects. A file of another shape (an empty `{}`, say) is refused rather than restored.
 */
function isDirectAppStore(value: Record<string, unknown>): boolean {
  return value.schemaVersion === 1 && isPlainObject(value.entries) && Object.values(value.entries).every(isPlainObject);
}

/** The empty Added-app store, byte for byte as its writer (`writeJSON` in lib/storage/json-store.ts) makes it. */
const EMPTY_DIRECT_APP_STORE = JSON.stringify({ schemaVersion: 1, entries: {} }, null, 2);

/**
 * Why a restore refuses a Market file (null when it takes it): every file is a JSON object, and the Added-app store
 * is that store. The one rule for both the backup and the restore.
 */
function marketFileProblem(name: MarketBackupFile, bytes: Buffer): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return 'it is not JSON'; }
  if (!isPlainObject(parsed)) return 'it is not a JSON object';
  if (name === 'direct-market-apps.json' && !isDirectAppStore(parsed)) return 'it is not a store of apps added by URL';
  return null;
}

/**
 * An Added-app store the Market reads as holding no apps (`loadStore` in lib/market/direct-apps.ts): JSON without an
 * `entries` object (`{}`, `null`, `[]`, `entries: null`), or with an empty one.
 */
function holdsNoDirectApps(bytes: Buffer): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return false; }
  const entries = isPlainObject(parsed) ? parsed.entries : undefined;
  return !isPlainObject(entries) || Object.keys(entries).length === 0;
}

/** The Market files of a backup, read and checked before a restore changes anything. */
export interface MarketStateFromBackup {
  files: Array<{ name: MarketBackupFile; bytes: Buffer }>;
}

/**
 * The Market files a core backup holds, checked: `recorded` is the backup's `marketFiles`. Null for a backup made
 * before Market files were backed up (no `marketFiles`): the restore leaves the target's files alone. Throws when
 * the record and the archive disagree, a file is not a JSON object, or the Added-app store is not that store.
 */
export async function readMarketStateFromBackup(coreStagingDir: string, recorded: unknown): Promise<MarketStateFromBackup | null> {
  if (recorded === undefined) return null;
  if (!Array.isArray(recorded) || !recorded.every(isMarketBackupFile) || new Set(recorded).size !== recorded.length) {
    throw new Error('Core backup has an invalid list of Market files');
  }
  const files: MarketStateFromBackup['files'] = [];
  for (const name of recorded) {
    const file = path.join(coreStagingDir, MARKET_DIRECTORY, name);
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile()) throw new Error(`Core backup is missing its Market file ${name}`);
    if (info.size > MAX_MARKET_FILE_BYTES) throw new Error(`Core backup's Market file ${name} is too large`);
    const bytes = await readFile(file);
    if (marketFileProblem(name, bytes)) throw new Error(`Core backup's Market file ${name} is not valid`);
    files.push({ name, bytes });
  }
  return { files };
}

/**
 * Put the backup's Market files in place: each one it holds is written (atomically, 0600), each one it does not hold
 * is removed, so the box's markets and Added apps are the backup's.
 */
export async function restoreMarketState(state: MarketStateFromBackup, dataRoot = DEFAULT_DATA_ROOT): Promise<void> {
  for (const name of Object.keys(MARKET_BACKUP_FILES) as MarketBackupFile[]) {
    const target = marketFilePath(name, dataRoot);
    const file = state.files.find((entry) => entry.name === name);
    if (!file) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    try {
      await writeFile(temporary, file.bytes, { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}
