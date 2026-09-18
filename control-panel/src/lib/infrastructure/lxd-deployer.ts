import { createHash } from 'crypto';
import { cachedReleaseBytes } from '../releases/cache';
/**
 * LXD container deployment via Incus REST API (v2).
 * Used for full-OS containers (Debian) that run Node.js apps.
 *
 * v2 changes:
 *   - Socket proxies (Incus + Spine) REMOVED — apps no longer get infrastructure access
 *   - security.nesting removed (not needed without sockets)
 */

import { incusRequest, execShell, incusUploadFile } from '../incus/server';
import { applyStaticIP } from '../incus/static-ips';
import type { LXDContainerSpec } from './types';
import { containerExists } from './oci-deployer';
import type { ReleaseSource } from '../apps/release-source';
import {
  resolveExactInfrastructureStandaloneRelease,
  resolveInfrastructureStandaloneRelease,
  type ResolvedInfrastructureRelease,
} from './release-resolver';
import { signedReleaseVerificationShell, verifySignedReleaseArtifactBuffer } from '@/lib/releases/verify';
import { effectiveChannel } from '@/lib/updates/channels';
import {
  readStagedMarketNativeArtifact,
  type StagedMarketNativeArtifact,
} from '@/lib/market/native-artifact';

type LXDDeploymentConfig = {
  spineSocketPath: string;
  giteaBaseURL: string;
  giteaOrg: string;
  giteaRepo: string;
  releaseChannelKey?: string;
  tagPrefix?: string;
  exposeHostPort?: boolean;
};

function storageDevices(spec: LXDContainerSpec): Record<string, Record<string, string>> {
  return Object.fromEntries((spec.volumes ?? []).map((volume, index) => [
    `volume${index}`,
    volume.kind === 'custom'
      ? {
          type: 'disk',
          pool: volume.pool,
          source: volume.source,
          path: volume.container,
          ...(volume.readOnly ? { readonly: 'true' } : {}),
        }
      : {
          type: 'disk',
          source: volume.host,
          path: volume.container,
          shift: 'true',
          ...(volume.readOnly ? { readonly: 'true' } : {}),
        },
  ]));
}

/**
 * Deploy an LXD container from a spec.
 * Resolves the release, creates a Debian container, installs Node.js, and downloads the app.
 * Idempotent — skips if container already exists.
 */
export async function deployLXDContainer(
  spec: LXDContainerSpec,
  cfg: LXDDeploymentConfig,
  nicDevices?: Record<string, Record<string, string>>,
): Promise<ResolvedInfrastructureRelease | null> {
  return deployLXDContainerInternal(spec, cfg, nicDevices);
}

/**
 * Market-only native app deployment. The Market engine must have downloaded,
 * inspected, classified, and digest-bound these exact bytes before it creates
 * any app-owned resources. Platform callers deliberately cannot select this
 * policy through deployLXDContainer; Pointer and stock YouEye LXD releases
 * remain signature-required there.
 */
export async function deployMarketLXDContainer(
  spec: LXDContainerSpec,
  cfg: LXDDeploymentConfig,
  artifact: StagedMarketNativeArtifact,
  nicDevices?: Record<string, Record<string, string>>,
): Promise<ResolvedInfrastructureRelease | null> {
  return deployLXDContainerInternal(spec, cfg, nicDevices, artifact);
}

async function deployLXDContainerInternal(
  spec: LXDContainerSpec,
  cfg: LXDDeploymentConfig,
  nicDevices?: Record<string, Record<string, string>>,
  marketArtifact?: StagedMarketNativeArtifact,
): Promise<ResolvedInfrastructureRelease | null> {
  if (await containerExists(spec.containerName)) return null;

  // Resolve the exact asset before mutating Incus. This avoids leaving a
  // half-created container merely because the desired release was beyond the
  // first API page or did not carry standalone.tar.
  const release = marketArtifact
    ? {
        tag: marketArtifact.tag,
        version: marketArtifact.version,
        url: '',
        artifactSHA256: marketArtifact.artifactSHA256,
      }
    : await resolveLXDRelease(cfg);

  // Create the LXD container
  const createPayload: Record<string, unknown> = {
    name: spec.containerName,
    source: {
      type: 'image',
      server: spec.imageServer,
      protocol: spec.imageProtocol,
      alias: spec.image,
    },
    config: {
      'boot.autostart': 'true',
      'security.privileged': 'false',
    },
  };

  // If per-app bridge NIC provided, attach to container at creation time
  createPayload.devices = { ...storageDevices(spec), ...(nicDevices ?? {}) };

  const result = await incusRequest<Record<string, unknown>>(
    'POST',
    '/1.0/instances',
    createPayload,
    { timeout: 300_000 } // 5 min for image download
  );

  if (result.error && result.error !== '') {
    throw new Error(`Failed to create LXD container: ${result.error}`);
  }

  if (result.type === 'async' && result.operation) {
    await waitForLXDOperation(result.operation, 300);
  }

  // Set static IP for system containers before starting
  try {
    await applyStaticIP(spec.containerName);
  } catch (err) {
    console.warn(`[lxd-deployer] Could not apply static IP to ${spec.containerName}:`, err);
  }

  // Start the container
  const startResult = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${spec.containerName}/state`,
    { action: 'start' }
  );
  if (startResult.type === 'async' && startResult.operation) {
    await waitForLXDOperation(startResult.operation, 60);
  }

  // Wait for container to be running and network ready
  await waitForContainerReady(spec.containerName);

  // Disable IPv6 on ALL interfaces immediately after container start (BUG-LISA-001).
  // Node.js v22 undici/fetch uses happy-eyeballs and races IPv4 + IPv6. Incus containers
  // have a link-local IPv6 address but no global IPv6 route, so IPv6 connections time out.
  // The 'all' sysctl does NOT override an existing per-interface setting — eth0 and lo
  // must be set explicitly. Persisted to /etc/sysctl.d/99-disable-ipv6.conf for reboots.
  try {
    await execShell(
      spec.containerName,
      [
        'sysctl -w net.ipv6.conf.all.disable_ipv6=1',
        'sysctl -w net.ipv6.conf.default.disable_ipv6=1',
        'sysctl -w net.ipv6.conf.eth0.disable_ipv6=1',
        'sysctl -w net.ipv6.conf.lo.disable_ipv6=1',
        'mkdir -p /etc/sysctl.d',
        'echo net.ipv6.conf.all.disable_ipv6=1 > /etc/sysctl.d/99-disable-ipv6.conf',
        'echo net.ipv6.conf.default.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
        'echo net.ipv6.conf.eth0.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
        'echo net.ipv6.conf.lo.disable_ipv6=1 >> /etc/sysctl.d/99-disable-ipv6.conf',
      ].join(' && '),
      { timeout: 10_000 }
    );
  } catch {
    // Non-fatal: sysctl may be restricted in some container setups.
  }

  // v2: Socket proxies removed — apps no longer get Incus/Spine access

  // Add port proxy for the app (skip if port conflicts)
  if (spec.port && cfg.exposeHostPort !== false) {
    try {
      await addPortProxy(spec.containerName, spec.port);
    } catch {
      // Port may conflict with another container (e.g. CP on 3000)
      // Non-fatal — the app is still reachable via Incus network
    }
  }

  // Install Node.js and deploy the application
  const artifactSHA256 = await installNodeAndApp(
    spec,
    release.url,
    release.artifactSHA256,
    marketArtifact,
  );
  return { ...release, artifactSHA256 };
}

/** Adopt an exact instance imported from a YouEye recovery point. */
export async function adoptRestoredLXDContainer(
  spec: LXDContainerSpec,
  nicDevices?: Record<string, Record<string, string>>,
): Promise<void> {
  const current = await incusRequest<{
    architecture?: string;
    config?: Record<string, string>;
    profiles?: string[];
    description?: string;
    status?: string;
  }>('GET', `/1.0/instances/${encodeURIComponent(spec.containerName)}`);
  if (current.type === 'error') throw new Error('Imported application runtime is unavailable');
  if (current.metadata.status !== 'Stopped') throw new Error('Imported application runtime must be stopped before adoption');
  const update = await incusRequest(
    'PUT',
    `/1.0/instances/${encodeURIComponent(spec.containerName)}`,
    {
      architecture: current.metadata.architecture,
      config: {
        ...(current.metadata.config ?? {}),
        'boot.autostart': 'true',
        'security.privileged': 'false',
      },
      devices: { ...storageDevices(spec), ...(nicDevices ?? {}) },
      profiles: current.metadata.profiles ?? ['default'],
      ephemeral: false,
      description: current.metadata.description ?? '',
    },
  );
  if (update.type === 'error') throw new Error('Imported application runtime could not be reconciled');
  if (update.type === 'async' && update.operation) await waitForLXDOperation(update.operation, 60);
  await applyStaticIP(spec.containerName);
  const started = await incusRequest<Record<string, unknown>>(
    'PUT',
    `/1.0/instances/${encodeURIComponent(spec.containerName)}/state`,
    { action: 'start' },
  );
  if (started.type === 'error') throw new Error('Imported application runtime could not start');
  if (started.type === 'async' && started.operation) await waitForLXDOperation(started.operation, 60);
  await waitForContainerReady(spec.containerName);
}

/**
 * Replace a partial or unhealthy full-OS container, then deploy it from the
 * currently resolved release. LXD application containers do not carry their
 * persistent data inside the deployment directory.
 */
export async function redeployLXDContainer(
  spec: LXDContainerSpec,
  cfg: LXDDeploymentConfig,
  nicDevices?: Record<string, Record<string, string>>,
): Promise<ResolvedInfrastructureRelease | null> {
  if (await containerExists(spec.containerName)) {
    const stopped = await incusRequest<Record<string, unknown>>(
      'PUT',
      `/1.0/instances/${encodeURIComponent(spec.containerName)}/state`, {
        action: 'stop', force: true, timeout: 30,
      },
    );
    if (stopped.error) throw new Error(`Failed to stop ${spec.containerName}: ${stopped.error}`);
    if (stopped.type === 'async' && stopped.operation) {
      await waitForLXDOperation(stopped.operation, 60);
    }

    const deleted = await incusRequest<Record<string, unknown>>(
      'DELETE',
      `/1.0/instances/${encodeURIComponent(spec.containerName)}`,
    );
    if (deleted.error) throw new Error(`Failed to delete ${spec.containerName}: ${deleted.error}`);
    if (deleted.type === 'async' && deleted.operation) {
      await waitForLXDOperation(deleted.operation, 60);
    }
    if (await containerExists(spec.containerName)) {
      throw new Error(`Failed to delete ${spec.containerName}: instance still exists after delete operation`);
    }
  }

  return deployLXDContainer(spec, cfg, nicDevices);
}

/** Wait for an async Incus operation. */
async function waitForLXDOperation(operationPath: string, timeoutSeconds = 300): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  const resp = await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });

  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (meta && (meta.status as string) === 'Failure') {
    throw new Error(`Operation failed: ${(meta.err as string) || 'unknown'}`);
  }
}

/** Wait for container to be running and exec-ready. */
async function waitForContainerReady(containerName: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const result = await execShell(containerName, 'echo ready', { timeout: 5000 });
      if (result.stdout.trim() === 'ready') return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container ${containerName} did not become ready in 30s`);
}

/** Add a port proxy device. */
async function addPortProxy(containerName: string, port: number): Promise<void> {
  const current = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${containerName}`);
  const metadata = current.metadata as Record<string, unknown>;
  const existingDevices = (metadata.devices as Record<string, Record<string, string>>) || {};

  const newDevices = {
    ...existingDevices,
    [`port${port}`]: {
      type: 'proxy',
      bind: 'host',
      listen: `tcp:0.0.0.0:${port}`,
      connect: `tcp:127.0.0.1:${port}`,
    },
  };

  await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices: newDevices });
}

async function resolveLXDRelease(cfg: LXDDeploymentConfig) {
  const releaseSource: ReleaseSource = {
    provider: cfg.giteaBaseURL.includes('github.com') ? 'github' : 'gitea',
    base_url: cfg.giteaBaseURL.replace(/\/$/, ''),
    api_path: cfg.giteaBaseURL.includes('github.com') ? '' : '/api/v1',
    organization: cfg.giteaOrg,
  };

  let releaseBranch = 'main';
  let exactTag = '';
  let artifactSHA256 = '';
  try {
    const channel = await effectiveChannel(cfg.releaseChannelKey || 'ui');
    if (/^[a-zA-Z0-9._/-]+$/.test(channel.branch)) releaseBranch = channel.branch;
    exactTag = channel.tag || '';
    artifactSHA256 = channel.artifact_sha256 || '';
  } catch {
    // Stable main remains the explicit fallback when Spine config is unavailable.
  }

  if (exactTag || artifactSHA256) {
    if (!exactTag || !artifactSHA256) {
      throw new Error('Exact UI release requires both a tag and artifact SHA-256');
    }
    return resolveExactInfrastructureStandaloneRelease(
      releaseSource,
      cfg.giteaRepo,
      exactTag,
      artifactSHA256,
    );
  }

  return resolveInfrastructureStandaloneRelease(
    releaseSource,
    cfg.giteaRepo,
    cfg.tagPrefix || '',
    releaseBranch,
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/** Install Node.js and deploy the app from the configured release source. */
async function installNodeAndApp(
  spec: LXDContainerSpec,
  releaseURL: string,
  artifactSHA256?: string,
  marketArtifact?: StagedMarketNativeArtifact,
): Promise<string> {
  const cn = spec.containerName;

  // Install prerequisites
  await execShell(cn, 'apt-get update && apt-get install -y curl ca-certificates pamtester', {
    timeout: 120_000,
  });

  // The container root account is not a login surface. Lock it instead of
  // generating a throwaway password that would have to cross a shell argv.
  await execShell(cn, 'passwd --lock root', { timeout: 10_000 });

  // Node applications use the established repository install. Bun applications
  // carry their exact runtime inside the signed release artifact so deployment
  // never executes an unpinned runtime installer from the network.
  if (spec.runtime !== 'bun') {
    await execShell(cn, `curl -fsSL https://deb.nodesource.com/setup_${spec.nodeVersion} | bash -`, {
      timeout: 60_000,
    });
    await execShell(cn, 'apt-get install -y nodejs', { timeout: 60_000 });
  }

  // The Control Panel resolves the exact release across every API page before
  // creating the container. The container only downloads that selected asset.
  await execShell(cn, `mkdir -p ${spec.appDir}`, { timeout: 10_000 });

  if (marketArtifact) {
    const bytes = await readStagedMarketNativeArtifact(marketArtifact);
    await incusUploadFile(cn, '/tmp/app.tar', bytes, { timeout: 300_000, mode: '0600' });
  }

  const cachedRelease = marketArtifact ? null : await cachedReleaseBytes(releaseURL);
  if (cachedRelease) {
    await verifySignedReleaseArtifactBuffer(releaseURL, cachedRelease, 'standalone.tar', artifactSHA256);
    await incusUploadFile(cn, '/tmp/app.tar', cachedRelease, { timeout: 300_000, mode: '0600' });
  }
  const downloadURL = marketArtifact ? '' : shellQuote(releaseURL);
  const artifactPreparation = cachedRelease
    ? `test "$(sha256sum /tmp/app.tar | awk '{print $1}')" = ${shellQuote(artifactSHA256 || createHash('sha256').update(cachedRelease).digest('hex'))}`
    : marketArtifact
    ? `
    echo "Using preflighted Market artifact..."
    test "$(sha256sum /tmp/app.tar | awk '{print $1}')" = ${shellQuote(marketArtifact.artifactSHA256)}
    `
    : `
    echo "Downloading selected standalone release..."
    retry 3 5 curl -fsSL ${downloadURL} -o /tmp/app.tar
    ${signedReleaseVerificationShell(releaseURL, '/tmp/app.tar', artifactSHA256)}
    `;

  const downloadScript = `
    set -e

    # Retry helper: retry <max_attempts> <delay_seconds> <command...>
    retry() {
      local max=\$1 delay=\$2; shift 2
      local attempt=1
      while true; do
        if "$@"; then return 0; fi
        if [ \$attempt -ge \$max ]; then return 1; fi
        echo "Attempt \$attempt failed, retrying in \${delay}s..."
        sleep \$delay
        attempt=\$((attempt + 1))
        delay=\$((delay * 2))
      done
    }

    ${artifactPreparation}
    sha256sum /tmp/app.tar | awk '{print \$1}' > ${spec.appDir}/.youeye-artifact-sha256
    tar -xf /tmp/app.tar -C ${spec.appDir} --no-same-owner
    rm /tmp/app.tar

    # Verify the download actually produced the app
    if [ ! -f "${spec.appDir}/${spec.entryFile ?? 'server.js'}" ]; then
      echo "ERROR: Download completed but ${spec.entryFile ?? 'server.js'} not found in ${spec.appDir}"
      ls -la ${spec.appDir}
      exit 1
    fi
    ${spec.runtime === 'bun' ? `test -x "${spec.appDir}/bun" || { echo "ERROR: signed Bun runtime is missing or not executable"; exit 1; }` : ''}
    echo "App downloaded and verified successfully"
  `;
  const dlResult = await execShell(cn, downloadScript, { timeout: 300_000 });
  if (dlResult.exitCode !== 0) {
    throw new Error(
      `App download failed for ${cn} (exit ${dlResult.exitCode}): ${dlResult.stdout} ${dlResult.stderr}`
    );
  }

  if (spec.postInstallCommands?.length) {
    for (const cmd of spec.postInstallCommands) {
      await execShell(cn, `cd ${spec.appDir} && ${cmd}`, { timeout: 120_000 });
    }
  }

  // Create systemd service file using base64 (more reliable than heredoc over exec API)
  const serviceName = spec.containerName;
  const serviceFile = `[Unit]
Description=${spec.displayName}
After=network.target

[Service]
Type=simple
WorkingDirectory=${spec.appDir}
ExecStart=${spec.runtime === 'bun' ? `${spec.appDir}/bun` : '/usr/bin/node'} ${spec.appDir}/${spec.entryFile ?? 'server.js'}
EnvironmentFile=-/etc/${spec.containerName}.env
Environment=NODE_ENV=production
Environment=PORT=${spec.port}
Environment=HOSTNAME=0.0.0.0
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`;
  const b64 = Buffer.from(serviceFile).toString('base64');
  await execShell(cn, `echo '${b64}' | base64 -d > /etc/systemd/system/${serviceName}.service`, {
    timeout: 10_000,
  });

  // Enable and start the service
  await execShell(cn, 'systemctl daemon-reload', { timeout: 10_000 });
  if (!spec.deferStart) {
    await execShell(cn, `systemctl enable --now ${serviceName}`, { timeout: 15_000 });
  }

  const digestResult = await execShell(cn, `cat ${spec.appDir}/.youeye-artifact-sha256`, { timeout: 10_000 });
  const verifiedDigest = digestResult.stdout.trim().toLowerCase();
  if (digestResult.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(verifiedDigest)) {
    throw new Error(`Signed artifact digest was not retained for ${cn}`);
  }
  if (artifactSHA256 && verifiedDigest !== artifactSHA256.toLowerCase()) {
    throw new Error(`Retained artifact digest does not match the exact channel for ${cn}`);
  }
  return verifiedDigest;
}
