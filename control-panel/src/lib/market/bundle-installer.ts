/**
 * Bundle install-and-wire engine.
 *
 * Installs a bundle's member apps in order (skipping already-installed ones), then
 * auto-approves the bundle's declared app→app connections — re-wiring members that were
 * already installed. Idempotent: re-running on a partially-installed bundle installs the
 * missing members and (re)wires the connections without erroring.
 *
 * Reuses existing primitives only: the per-app install engine (`installApp`), the
 * connection/bridge approve flow (`createBridge` + `resolveBridgeMappings` + `activateBridge`),
 * and shared storage groups (realized by each member's `storageGroup` volume at install).
 */

import { installApp } from './engine';
import { fetchManifest, fetchManifestReferenceFromSource } from './catalog';
import { listInstalledApps, readInstallMetadata } from './metadata';
import { createBridge, resolveBridgeMappings, activateBridge, detectBridgeDependencies } from '../bridges/manager';
import { updateBridge, loadBridges } from '../bridges/store';
import type { EnvMapping } from '../bridges/store';
import { settingsService } from '../settings';
import type { InstallConfig, InstallEventCallback, MarketBundle } from './types';

async function platformDomain(): Promise<string> {
  const settings = await settingsService.getRaw();
  const domain = typeof settings.domain === 'string' ? settings.domain.trim() : '';
  if (!domain) throw new Error('Platform domain is not configured');
  return domain;
}

/**
 * Wire a from→to connection: create (or reuse) the bridge and, when the target is
 * installed, resolve its backend mappings and activate it. Idempotent — an existing
 * from→to bridge is reused rather than duplicated.
 */
async function approveConnection(fromAppId: string, toAppId: string): Promise<{ bridgeId: string; activated: boolean }> {
  const bridges = await loadBridges();
  const existing = bridges.find((b) => b.from === fromAppId && b.to === toAppId);

  // Derive backend env mappings (keys/URLs) from the source app's manifest.
  let envMappings: EnvMapping[] = [];
  let defaultPort = 8080;
  try {
    const manifest = await fetchManifest(fromAppId);
    if (manifest.env_mapping) {
      envMappings = detectBridgeDependencies(manifest.env_mapping, fromAppId)
        .filter((d) => d.targetAppId === toAppId)
        .flatMap((d) => d.envMappings);
    }
    const want = manifest.wants?.find((w) => w.appId === toAppId);
    if (want?.defaultPort) defaultPort = want.defaultPort;
  } catch {
    // proceed without env mappings — a network bridge is still created
  }

  const bridge = existing ?? (await createBridge({ from: fromAppId, to: toAppId, envMappings, approvedBy: 'bundle' }));

  const targetMeta = await readInstallMetadata(toAppId);
  if (!targetMeta) return { bridgeId: bridge.id, activated: false };

  const targetContainer = targetMeta.containers?.[0]?.containerName || `app-${toAppId}`;
  const targetSub = targetMeta.subdomain || toAppId;
  const domain = await platformDomain();
  const resolved = await resolveBridgeMappings(envMappings, targetContainer, defaultPort, targetSub, domain);
  await updateBridge(bridge.id, { envMappings: resolved });
  const result = await activateBridge(bridge.id);
  return { bridgeId: bridge.id, activated: !!result?.active };
}

export interface BundleInstallResult {
  bundleId: string;
  members: { appId: string; status: 'installed' | 'already-installed' | 'failed'; error?: string }[];
  connections: { from: string; to: string; status: 'wired' | 'pending' | 'failed'; error?: string }[];
}

/**
 * Install + wire a bundle. Emits InstallEvents through `onEvent` so the caller can stream
 * progress (SSE), and returns a structured per-member / per-connection result.
 */
export async function installBundle(
  bundle: MarketBundle,
  onEvent: InstallEventCallback,
  signal?: AbortSignal,
): Promise<BundleInstallResult> {
  const result: BundleInstallResult = { bundleId: bundle.id, members: [], connections: [] };
  const installedMetas = await listInstalledApps();
  const installed = new Set(installedMetas.map((m) => m.appId));
  const domain = await platformDomain();
  const totalSteps = bundle.members.length + bundle.connections.length;
  let step = 0;

  // 1. Install missing members in order (providers before consumers). Shared storage
  //    groups are realized by each member's `storageGroup` volume during its install.
  for (const memberId of bundle.members) {
    step++;
    if (installed.has(memberId)) {
      result.members.push({ appId: memberId, status: 'already-installed' });
      onEvent({ step, totalSteps, status: 'skipped', message: `${memberId} already installed`, phase: 'install' });
      continue;
    }
    try {
      const manifest = await fetchManifest(memberId);
      const reference = await fetchManifestReferenceFromSource(memberId).catch(() => null);
      const config: InstallConfig = {
        appId: memberId,
        subdomain: (manifest.metadata.defaultSubdomain || memberId).toLowerCase(),
        domain,
        ...(reference
          ? {
              manifestPath: reference.path,
              manifestRepo: reference.repo,
              manifestBranch: reference.branch,
              manifestDigest: reference.digest,
            }
          : {}),
      };
      onEvent({ step, totalSteps, status: 'running', message: `Installing ${manifest.metadata.name}…`, phase: 'install' });
      await installApp(manifest, config, (e) => onEvent({ ...e, step, totalSteps }), signal);
      installed.add(memberId);
      result.members.push({ appId: memberId, status: 'installed' });
      onEvent({ step, totalSteps, status: 'success', message: `Installed ${manifest.metadata.name}`, phase: 'install' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.members.push({ appId: memberId, status: 'failed', error: msg });
      onEvent({ step, totalSteps, status: 'error', message: `Failed to install ${memberId}: ${msg}`, phase: 'install' });
    }
  }

  // 2. Auto-approve the declared connections — re-wires already-installed members too.
  for (const conn of bundle.connections) {
    step++;
    if (!installed.has(conn.from) || !installed.has(conn.to)) {
      result.connections.push({ from: conn.from, to: conn.to, status: 'pending' });
      onEvent({ step, totalSteps, status: 'skipped', message: `Connection ${conn.from} → ${conn.to} pending (member not installed)`, phase: 'verify' });
      continue;
    }
    try {
      onEvent({ step, totalSteps, status: 'running', message: `Connecting ${conn.from} → ${conn.to}…`, phase: 'verify' });
      const { activated } = await approveConnection(conn.from, conn.to);
      result.connections.push({ from: conn.from, to: conn.to, status: activated ? 'wired' : 'pending' });
      onEvent({ step, totalSteps, status: activated ? 'success' : 'warning', message: `${activated ? 'Connected' : 'Bridged (target pending)'} ${conn.from} → ${conn.to}`, phase: 'verify' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.connections.push({ from: conn.from, to: conn.to, status: 'failed', error: msg });
      onEvent({ step, totalSteps, status: 'error', message: `Failed to connect ${conn.from} → ${conn.to}: ${msg}`, phase: 'verify' });
    }
  }

  onEvent({ step: totalSteps, totalSteps, status: 'success', message: `Bundle "${bundle.name}" install-and-wire complete`, phase: 'verify' });
  return result;
}
