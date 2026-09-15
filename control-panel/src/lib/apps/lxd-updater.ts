/**
 * LXD Container Updater (Infrastructure + hardcoded native apps)
 *
 * Updates LXD containers (full Debian OS with Node.js apps) that are registered
 * in the AppDefinition system (definitions.ts). Uses snapshot → update → verify
 * → rollback pattern, operating on systemd services inside containers.
 *
 * NOTE: Market-installed native apps go through market/updater.ts which
 * provides migration support, variable context, and DB version tracking.
 * This file handles infrastructure LXD apps (UI) and legacy definitions.
 *
 * Includes apt upgrade to keep base OS current inside LXD containers.
 */

import { readFile } from 'node:fs/promises';
import { execShell, incusUploadFile } from '@/lib/incus/server';
import {
  createSnapshot,
  restoreSnapshot,
  deleteSnapshot,
  waitForContainerExec,
  getServiceWorkingDir,
  upgradeContainerOS,
  healthCheckViaExec,
} from '@/lib/incus/snapshot';
import { type AppDefinition } from './definitions';
import { markAppUpdated } from './update-cache';
import type { UpdateEvent } from './updater';
export type { UpdateEvent };
import { settingsService } from '@/lib/settings';
import { isNewer, sortVersionsDesc } from '@/lib/version';
import { buildReleasesAPIURL, getReleaseAssetDownloadURL, getReleaseSource, type ReleaseAsset } from './release-source';
import { injectCaddyRootCA } from '@/lib/market/caddy-ca';
import { signedReleaseVerificationShell } from '@/lib/releases/verify';
import { recordCoreProvenance } from '@/lib/updates/provenance';

type EventEmitter = (event: UpdateEvent) => void;

const SNAPSHOT_NAME = 'pre-update';
const PERSISTENT_UI_ENV_PATH = '/var/lib/youeye/ui/.env';
interface ReleaseInfo {
  version: string;
  downloadURL: string;
  artifactSHA256?: string;
}

async function restorePersistentUIEnvironment(appId: string, containerName: string): Promise<void> {
  if (appId !== 'ui') return;
  let environment: Buffer;
  try {
    environment = await readFile(PERSISTENT_UI_ENV_PATH);
  } catch {
    throw new Error('Persistent UI environment is unavailable; refusing to restart UI without its database and identity configuration');
  }
  if (environment.length === 0) {
    throw new Error('Persistent UI environment is empty; refusing to restart UI without its database and identity configuration');
  }
  await incusUploadFile(containerName, '/etc/youeye-ui.env', environment, { mode: '0600' });
}

// ─── Version & Release Helpers ────────────────────────────────────────────────

async function getCurrentVersion(containerName: string, appDir: string): Promise<string> {
  try {
    const result = await execShell(containerName, `cat ${appDir}/package.json`, { timeout: 10_000 });
    if (result.exitCode === 0 && result.stdout) {
      const pkg = JSON.parse(result.stdout);
      return pkg.version || 'unknown';
    }
  } catch { /* container may not have package.json yet */ }
  return 'unknown';
}

async function getReleaseBranch(): Promise<string> {
  try {
    const config = await settingsService.getRaw();
    return config.release_branch || '';
  } catch {
    return '';
  }
}

function isMainTag(tag: string): boolean {
  return /^v\d/.test(tag);
}

async function getLatestRelease(containerName: string, giteaRepo: string, branch?: string, tagPrefix?: string): Promise<ReleaseInfo | null> {
  const releaseSource = await getReleaseSource();
  const releasesURL = buildReleasesAPIURL(releaseSource, giteaRepo);

  const result = await execShell(
    containerName,
    `curl -sSL -H 'User-Agent: youeye-control' '${releasesURL}'`,
    { timeout: 30_000 }
  );

  if (result.exitCode !== 0 || !result.stdout) return null;

  try {
    const allReleases = JSON.parse(result.stdout);
    if (!Array.isArray(allReleases) || allReleases.length === 0) return null;

    const pfx = tagPrefix ? `${tagPrefix}-` : '';
    const releases = pfx
      ? allReleases.filter((r: { tag_name: string }) => r.tag_name.startsWith(pfx))
      : allReleases;

    const stripPfx = (tag: string) => pfx ? tag.slice(pfx.length) : tag;
    const effectiveBranch = branch || '';
    let matchedRelease = null;

    const mainReleases = releases.filter((r: { tag_name: string }) => isMainTag(stripPfx(r.tag_name)));
    let bestMainVersion: string | null = null;
    let bestMainRelease = null;
    if (mainReleases.length > 0) {
      const sortedMainVersions = sortVersionsDesc(
        mainReleases.map((r: { tag_name: string }) => stripPfx(r.tag_name).replace(/^v/, ''))
      );
      bestMainVersion = sortedMainVersions[0];
      bestMainRelease = mainReleases.find(
        (r: { tag_name: string }) => stripPfx(r.tag_name) === `v${bestMainVersion}`
      );
    }

    if (effectiveBranch && effectiveBranch !== 'main') {
      const branchTagPrefix = `${effectiveBranch}-v`;
      const branchReleases = releases.filter((r: { tag_name: string }) =>
        stripPfx(r.tag_name).startsWith(branchTagPrefix)
      );
      if (branchReleases.length > 0) {
        const sortedBranchVersions = sortVersionsDesc(
          branchReleases.map((r: { tag_name: string }) => stripPfx(r.tag_name).replace(branchTagPrefix, ''))
        );
        const bestBranchVersion = sortedBranchVersions[0];
        const bestBranchRelease = branchReleases.find(
          (r: { tag_name: string }) => stripPfx(r.tag_name) === `${branchTagPrefix}${bestBranchVersion}`
        );

        if (bestMainVersion && isNewer(bestMainVersion, bestBranchVersion)) {
          matchedRelease = bestMainRelease;
        } else {
          matchedRelease = bestBranchRelease;
        }
      }
    }

    if (!matchedRelease && bestMainRelease) matchedRelease = bestMainRelease;
    if (!matchedRelease && releases.length > 0) matchedRelease = releases[0];
    if (!matchedRelease) return null;

    const tag = matchedRelease.tag_name as string || '';
    const strippedTag = stripPfx(tag);
    let version: string;
    if (effectiveBranch && effectiveBranch !== 'main' && strippedTag.startsWith(`${effectiveBranch}-v`)) {
      version = strippedTag.replace(`${effectiveBranch}-v`, '');
    } else {
      version = strippedTag.replace(/^v/, '');
    }

    const assets = matchedRelease.assets as ReleaseAsset[];
    const tarAsset = assets?.find((a) => a.name === 'standalone.tar');
    if (!tarAsset || !version) return null;
    const downloadURL = getReleaseAssetDownloadURL(releaseSource, tarAsset, tag);
    if (!downloadURL) return null;

    return { version, downloadURL };
  } catch {
    return null;
  }
}

// getReleaseByTag resolves the download URL for an EXACT release tag. Used when
// the caller (channel-aware update route) has already resolved the candidate —
// the updater must install precisely that tag, not re-resolve on its own.
async function getReleaseByTag(containerName: string, giteaRepo: string, tag: string): Promise<string | null> {
  const releaseSource = await getReleaseSource();
  const releasesURL = buildReleasesAPIURL(releaseSource, giteaRepo);
  const result = await execShell(
    containerName,
    `curl -sSL -H 'User-Agent: youeye-control' '${releasesURL}'`,
    { timeout: 30_000 }
  );
  if (result.exitCode !== 0 || !result.stdout) return null;
  try {
    const allReleases = JSON.parse(result.stdout);
    if (!Array.isArray(allReleases)) return null;
    const match = allReleases.find((r: { tag_name?: string }) => r.tag_name === tag);
    if (!match) return null;
    const assets = match.assets as ReleaseAsset[];
    const tarAsset = assets?.find((a) => a.name === 'standalone.tar');
    if (!tarAsset) return null;
    return getReleaseAssetDownloadURL(releaseSource, tarAsset, tag);
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Update an LXD app by downloading a new release tarball and replacing
 * the app files inside the container. Includes apt upgrade for OS currency.
 */
export async function updateLXDApp(
  appDef: AppDefinition,
  emit: EventEmitter,
  // Channel-resolved candidate: install EXACTLY this tag (no internal
  // re-resolution, no is-newer no-op guard — the caller already decided).
  override?: { version: string; tag: string; branch?: string; source?: string; artifactSHA256?: string }
): Promise<void> {
  if (!appDef.lxdConfig) {
    throw new Error(`App ${appDef.id} has no lxdConfig`);
  }

  const containerName = appDef.containers[0].name;
  const {
    giteaRepo,
    tagPrefix,
    appDir: configuredAppDir,
    serviceName,
    healthEndpoint,
    installStyledJsx = true,
    migrationCommand,
  } = appDef.lxdConfig;

  emit({ stage: 'starting', message: `Starting update for ${appDef.displayName}`, progress: 0 });

  if (override?.artifactSHA256 && !/^[0-9a-f]{64}$/.test(override.artifactSHA256)) {
    throw new Error('Exact update artifact SHA-256 must be 64 lowercase hexadecimal characters');
  }

  // 1. Resolve real app directory
  const appDir = await getServiceWorkingDir(containerName, serviceName, configuredAppDir);
  if (appDir !== configuredAppDir) {
    emit({ stage: 'starting', message: `Note: service runs from ${appDir} (configured: ${configuredAppDir})`, progress: 1 });
  }

  // 2. Get release branch
  const branch = await getReleaseBranch();
  if (branch && branch !== 'main') {
    emit({ stage: 'starting', message: `Release branch: ${branch}`, progress: 2 });
  }

  // 3. Get current version
  const currentVersion = await getCurrentVersion(containerName, appDir);
  emit({ stage: 'starting', message: `Current version: ${currentVersion}`, progress: 5 });

  // 4. Resolve the release to install: the caller's channel-resolved candidate
  // when provided, else legacy latest-release resolution.
  let release: ReleaseInfo;
  if (override) {
    const url = await getReleaseByTag(containerName, giteaRepo, override.tag);
    if (!url) throw new Error(`Release tag ${override.tag} not found (or has no standalone.tar) on the configured release source`);
    release = { version: override.version, downloadURL: url, artifactSHA256: override.artifactSHA256 };
    emit({ stage: 'starting', message: `Installing ${override.tag}`, progress: 10 });
  } else {
    const latest = await getLatestRelease(containerName, giteaRepo, branch, tagPrefix);
    if (!latest) throw new Error('Could not fetch latest release from the configured release source');
    release = latest;
    emit({ stage: 'starting', message: `Latest version: ${release.version}`, progress: 10 });
  }

  const releaseIsCurrent = !override
    && (currentVersion === release.version || (currentVersion !== 'unknown' && !isNewer(release.version, currentVersion)));

  // 5. Create snapshot before any trust, package, service, or file mutation.
  emit({ stage: 'snapshot', message: `Creating snapshot of ${containerName}`, container: containerName, progress: 15 });
  await createSnapshot(containerName, SNAPSHOT_NAME);

  try {
    // 6. Ensure managed HTTPS URLs are trusted after the rollback point exists.
    try {
      await injectCaddyRootCA(containerName);
      emit({ stage: 'starting', message: `Caddy root CA trusted in ${containerName}`, progress: 18 });
    } catch (err) {
      emit({ stage: 'starting', message: `Caddy root CA trust repair skipped: ${err instanceof Error ? err.message : String(err)}`, progress: 18 });
    }

    // System-image convergence can recreate the UI container while the
    // authoritative database and identity environment remains on persistent
    // appliance state. Repair it before both no-op restarts and real updates;
    // otherwise Next.js silently falls back to PostgreSQL on localhost and app
    // lifecycle operations fail after they have already begun cleanup.
    await restorePersistentUIEnvironment(appDef.id, containerName);

    if (releaseIsCurrent) {
      emit({ stage: 'starting-container', message: `Restarting ${serviceName} to apply trust repairs`, container: containerName, progress: 75 });
      await execShell(containerName, `systemctl restart ${serviceName}`, { timeout: 30_000 });
      await healthCheckViaExec(containerName, appDef.webPort ?? 3000, healthEndpoint || '/api/health', 15);
      await deleteSnapshot(containerName, SNAPSHOT_NAME);
      emit({ stage: 'completed', message: `${appDef.displayName} is already up to date (${currentVersion})`, progress: 100 });
      return;
    }

    // 7. Download and verify the complete archive before stopping services or replacing files.
    emit({ stage: 'rebuilding', message: `Downloading v${release.version}`, container: containerName, progress: 20 });
    const downloadResult = await execShell(
      containerName,
      `curl -sSL "${release.downloadURL}" -o /tmp/update.tar`,
      { timeout: 300_000 }
    );
    if (downloadResult.exitCode !== 0) throw new Error(`Download failed: ${downloadResult.stderr}`);
    const signatureResult = await execShell(containerName, signedReleaseVerificationShell(release.downloadURL, '/tmp/update.tar', release.artifactSHA256), { timeout: 300_000 });
    if (signatureResult.exitCode !== 0) throw new Error(`Signed release verification failed: ${signatureResult.stderr}`);
    emit({ stage: 'rebuilding', message: 'Release signature and artifact digest verified', container: containerName, progress: 30 });

    // 8. Upgrade base OS packages
    emit({ stage: 'rebuilding', message: 'Upgrading system packages...', container: containerName, progress: 35 });
    try {
      await upgradeContainerOS(containerName);
    } catch (err) {
      // Non-fatal — continue with app update
      emit({ stage: 'rebuilding', message: `System upgrade skipped: ${err instanceof Error ? err.message : String(err)}`, progress: 38 });
    }

    // 9. Stop systemd service
    emit({ stage: 'stopping', message: `Stopping ${serviceName} service`, container: containerName, progress: 40 });
    await execShell(containerName, `systemctl stop ${serviceName}`, { timeout: 30_000 });

    // 10. Replace files from the already-verified archive.
    await execShell(containerName, `rm -rf ${appDir}`, { timeout: 30_000 });
    await execShell(containerName, `mkdir -p ${appDir}`, { timeout: 10_000 });

    emit({ stage: 'rebuilding', message: 'Extracting files', container: containerName, progress: 55 });
    const extractResult = await execShell(
      containerName,
      `tar -xf /tmp/update.tar -C ${appDir} --no-same-owner`,
      { timeout: 60_000 }
    );
    if (extractResult.exitCode !== 0) throw new Error(`Extraction failed: ${extractResult.stderr}`);
    await execShell(containerName, 'rm -f /tmp/update.tar', { timeout: 10_000 });

    if (installStyledJsx) {
      emit({ stage: 'rebuilding', message: 'Installing dependencies', container: containerName, progress: 60 });
      await execShell(
        containerName,
        `cd ${appDir} && mkdir -p node_modules/styled-jsx && ` +
        `TARBALL=$(curl -sSL https://registry.npmjs.org/styled-jsx/latest | ` +
        `grep -o '"tarball":"[^"]*"' | head -1 | cut -d'"' -f4) && ` +
        `[ -n "$TARBALL" ] && curl -sSL "$TARBALL" | tar -xzf - -C node_modules/styled-jsx --strip-components=1 || true`,
        { timeout: 30_000 }
      );
    }

    if (migrationCommand) {
      emit({ stage: 'rebuilding', message: 'Applying database migrations', container: containerName, progress: 65 });
      const migration = await execShell(containerName, migrationCommand, { timeout: 120_000 });
      if (migration.exitCode !== 0) throw new Error('Database migration failed');
    }

    // 11. Start service
    emit({ stage: 'starting-container', message: `Starting ${serviceName} service`, container: containerName, progress: 70 });
    await execShell(containerName, `systemctl start ${serviceName}`, { timeout: 30_000 });

    // 12. Health check
    emit({ stage: 'verifying', message: 'Verifying app is running', container: containerName, progress: 80 });
    const endpoint = healthEndpoint || '/api/health';
    const port = appDef.webPort ?? 3000;
    await healthCheckViaExec(containerName, port, endpoint, 15);

    if (appDef.releaseChannelKey && override) {
      await recordCoreProvenance(appDef.releaseChannelKey, {
        version: override.version,
        tag: override.tag,
        branch: override.branch,
        source: override.source,
        artifactSHA256: override.artifactSHA256,
      });
    }

    // 13. Cleanup snapshot
    await deleteSnapshot(containerName, SNAPSHOT_NAME);

    markAppUpdated(appDef.id);

    emit({ stage: 'completed', message: `${appDef.displayName} updated to v${release.version}`, progress: 100 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    emit({ stage: 'rolling-back', message: `Update failed, rolling back: ${errMsg}`, container: containerName });

    try {
      await restoreSnapshot(containerName, SNAPSHOT_NAME);
      await waitForContainerExec(containerName, 30);
      await deleteSnapshot(containerName, SNAPSHOT_NAME);
    } catch (rollbackErr) {
      console.error(`[lxd-updater] Rollback failed for ${containerName}:`, rollbackErr);
    }

    emit({ stage: 'failed', message: errMsg, error: errMsg, progress: 0 });
    throw error;
  }
}
