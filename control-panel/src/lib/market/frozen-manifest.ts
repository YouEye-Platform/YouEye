import { execCommand } from '@/lib/incus/server';
import { loadFrozenApp } from './app-format/compile';
import { AppUpdatePreflightError } from './update-inventory';
import type { AppManifest, FrozenAppSource } from './types';

/**
 * Installed registration is the runtime contract; a mutable catalog is not.
 *
 * The registration (youeye_ui.apps.manifest) holds the compiled model the dashboard reads plus
 * `frozen`: the app's source `youeye-app.yaml` and setup files. The model is always rebuilt
 * from that source, read leniently (structure only), so a stricter validator never orphans an
 * installed app.
 */
/** The app model from a stored registration or backup manifest (its `frozen` source). */
export function appFromFrozenRegistration(registration: unknown): AppManifest {
  const frozen = (registration as { frozen?: Partial<FrozenAppSource> } | null)?.frozen;
  if (frozen?.schema !== 'youeye.frozen-app.v1' || typeof frozen.manifest !== 'string'
    || !frozen.setups || typeof frozen.setups !== 'object' || Array.isArray(frozen.setups)
    || Object.values(frozen.setups).some((text) => typeof text !== 'string')) {
    throw new Error('No frozen app source');
  }
  return loadFrozenApp({
    manifest: frozen.manifest,
    setups: frozen.setups as Record<string, string>,
    version: typeof frozen.version === 'string' ? frozen.version : undefined,
  });
}

/**
 * The installed app's model from its registration text. With `expectedDigest` (the install
 * record's `manifestDigest`), the digest recomputed from the frozen source must match it.
 */
export function parseFrozenAppManifest(raw: string, appId: string, installedVersion?: string, expectedDigest?: string): AppManifest {
  try {
    const manifest = appFromFrozenRegistration(JSON.parse(raw));
    if (manifest.metadata.id !== appId) throw new Error('Wrong app');
    if (installedVersion && manifest.version !== installedVersion) {
      throw new AppUpdatePreflightError('frozen-version-mismatch',
        'Installed manifest and recorded runtime version disagree.');
    }
    if (expectedDigest !== undefined && manifest.frozen?.digest !== expectedDigest) {
      throw new AppUpdatePreflightError('frozen-digest-mismatch',
        `The installed copy of ${appId}'s manifest does not match its install record `
        + `(copy ${manifest.frozen?.digest ?? 'none'}, record ${expectedDigest || 'none'}); it was changed after install.`);
    }
    return manifest;
  } catch (error) {
    if (error instanceof AppUpdatePreflightError) throw error;
    throw new AppUpdatePreflightError('frozen-manifest-unavailable',
      'A complete frozen installed manifest is required.');
  }
}

/** An installed app's model, rebuilt from its frozen copy (never the live catalog). */
export async function readInstalledAppManifest(appId: string): Promise<AppManifest> {
  return readFrozenUpdateManifest(appId);
}

/**
 * The model of an app that may or may not be installed: its frozen copy when it is installed,
 * otherwise the catalog's current manifest (`fromCatalog`).
 */
export async function installedOrCatalogManifest(
  appId: string,
  fromCatalog: () => Promise<AppManifest>,
): Promise<AppManifest> {
  const { readInstallMetadata } = await import('./metadata');
  return await readInstallMetadata(appId) ? readInstalledAppManifest(appId) : fromCatalog();
}

/**
 * An installed app's model from its registration's frozen copy, checked against the install
 * record: the copy's digest must equal the record's `manifestDigest`.
 */
export async function readFrozenUpdateManifest(appId: string, installedVersion?: string): Promise<AppManifest> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(appId)) throw new Error('Invalid app identity');
  const { readInstallMetadata } = await import('./metadata');
  const meta = await readInstallMetadata(appId);
  if (!meta) {
    throw new AppUpdatePreflightError('frozen-manifest-unavailable', `${appId} has no install record.`);
  }
  if (!meta.manifestDigest) {
    throw new AppUpdatePreflightError('frozen-digest-mismatch',
      `The install record of ${appId} has no manifest digest, so its installed copy cannot be checked.`);
  }
  const result = await execCommand('youeye-postgres', [
    'psql', '-U', 'youeye', '-d', 'youeye_ui', '-At', '-v', 'ON_ERROR_STOP=1', '-c',
    `SELECT manifest::text FROM apps WHERE id='${appId}'`,
  ], { timeout: 10_000 });
  if (result.exitCode !== 0) {
    throw new AppUpdatePreflightError('frozen-manifest-unavailable',
      'The installed app manifest could not be read.');
  }
  return parseFrozenAppManifest(result.stdout, appId, installedVersion, meta.manifestDigest);
}
