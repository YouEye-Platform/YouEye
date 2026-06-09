import { readFileSync } from 'fs';
import { CONTAINER_DOMAIN } from './constants';
import { fetchManifestFromSource, fetchManifestReferenceFromSource } from './catalog';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { upsertInstalledApp } from './installed-apps';

function readBridgeToken(): string | null {
  try {
    return readFileSync('/etc/youeye/ui-bridge-token', 'utf-8').trim();
  } catch (err) {
    if (!process.env.UI_BRIDGE_TOKEN) {
      console.warn('[market] UI bridge token file is not readable and UI_BRIDGE_TOKEN is not set', err);
    }
    return process.env.UI_BRIDGE_TOKEN ?? null;
  }
}

function uiBaseUrl(): string {
  return process.env.UI_INTERNAL_URL || `http://youeye-ui.${CONTAINER_DOMAIN}:3000`;
}

export async function syncInstalledAppManifestToUI(appId: string): Promise<{
  appId: string;
  sourceId: string | null;
  manifestPath: string;
  manifestRepo: string;
  manifestBranch: string;
  manifestDigest: string;
  version: string | null;
  surfaces: number;
}> {
  const metadata = await readInstallMetadata(appId);
  if (!metadata) {
    throw new Error(`App "${appId}" is not installed`);
  }

  const sourceId = metadata.sourceId || undefined;
  const [manifest, reference] = await Promise.all([
    fetchManifestFromSource(appId, sourceId),
    fetchManifestReferenceFromSource(appId, sourceId),
  ]);

  const bridgeToken = readBridgeToken();
  if (!bridgeToken) {
    throw new Error('UI bridge token is not configured');
  }

  const res = await fetch(`${uiBaseUrl()}/api/v1/apps/${encodeURIComponent(appId)}/manifest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-UI-Bridge-Token': bridgeToken,
    },
    body: JSON.stringify({ manifest }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UI manifest sync failed: ${res.status} ${text}`);
  }

  metadata.manifestPath = reference.path;
  metadata.manifestRepo = reference.repo;
  metadata.manifestBranch = reference.branch;
  metadata.manifestDigest = reference.digest;
  metadata.installedVersion = metadata.installedVersion || manifest.version || '';
  await saveInstallMetadata(metadata);

  await upsertInstalledApp({
    appId,
    type: metadata.integration,
    installedVersion: metadata.installedVersion ?? '',
    subdomain: metadata.subdomain,
    ssoSlug: metadata.ssoSlug,
    forwardAuthEnabled: metadata.forwardAuthEnabled,
    catalogKey: metadata.catalogKey,
    sourceId: metadata.sourceId,
    sourceName: metadata.sourceName,
    sourceRepoUrl: metadata.sourceRepoUrl,
  });

  return {
    appId,
    sourceId: metadata.sourceId ?? null,
    manifestPath: reference.path,
    manifestRepo: reference.repo,
    manifestBranch: reference.branch,
    manifestDigest: reference.digest,
    version: manifest.version ?? null,
    surfaces: manifest.surfaces?.length ?? 0,
  };
}

export async function syncAppManifestObjectToUI(
  appId: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const bridgeToken = readBridgeToken();
  if (!bridgeToken) {
    throw new Error('UI bridge token is not configured');
  }

  const res = await fetch(`${uiBaseUrl()}/api/v1/apps/${encodeURIComponent(appId)}/manifest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-UI-Bridge-Token': bridgeToken,
    },
    body: JSON.stringify({ manifest }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`UI manifest sync failed: ${res.status} ${text}`);
  }
}
