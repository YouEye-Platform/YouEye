/**
 * LXD container deployment via Incus REST API (v2).
 * Used for full-OS containers (Debian) that run Node.js apps.
 *
 * v2 changes:
 *   - Socket proxies (Incus + Spine) REMOVED — apps no longer get infrastructure access
 *   - security.nesting removed (not needed without sockets)
 */

import { incusRequest, execShell } from '../incus/server';
import { applyStaticIP } from '../incus/static-ips';
import type { LXDContainerSpec } from './types';
import { containerExists } from './oci-deployer';

/**
 * Deploy an LXD container from a spec.
 * Creates Debian container, installs Node.js, adds socket proxies, downloads app.
 * Idempotent — skips if container already exists.
 */
export async function deployLXDContainer(
  spec: LXDContainerSpec,
  cfg: {
    spineSocketPath: string;
    giteaBaseURL: string;
    giteaOrg: string;
    giteaRepo: string;
    tagPrefix?: string;
  },
  nicDevices?: Record<string, Record<string, string>>,
): Promise<void> {
  if (await containerExists(spec.containerName)) return;

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
      'security.privileged': 'false',
    },
  };

  // If per-app bridge NIC provided, attach to container at creation time
  if (nicDevices) {
    createPayload.devices = nicDevices;
  }

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
  if (spec.port) {
    try {
      await addPortProxy(spec.containerName, spec.port);
    } catch {
      // Port may conflict with another container (e.g. CP on 3000)
      // Non-fatal — the app is still reachable via Incus network
    }
  }

  // Install Node.js and deploy the application
  await installNodeAndApp(spec, cfg);
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

/** Install Node.js and deploy the app from Gitea releases. */
async function installNodeAndApp(
  spec: LXDContainerSpec,
  cfg: { giteaBaseURL: string; giteaOrg: string; giteaRepo: string; tagPrefix?: string }
): Promise<void> {
  const cn = spec.containerName;

  // Install prerequisites
  await execShell(cn, 'apt-get update && apt-get install -y curl ca-certificates pamtester', {
    timeout: 120_000,
  });

  // Set random root password
  const pwd = (await import('./secrets')).generatePassword(32);
  await execShell(cn, `echo 'root:${pwd}' | chpasswd`, { timeout: 10_000 });

  // Install Node.js
  await execShell(cn, `curl -fsSL https://deb.nodesource.com/setup_${spec.nodeVersion} | bash -`, {
    timeout: 60_000,
  });
  await execShell(cn, 'apt-get install -y nodejs', { timeout: 60_000 });

  // Download and deploy app from GitHub release (branch-aware)
  const releasesURL = `https://api.github.com/repos/${cfg.giteaOrg}/${cfg.giteaRepo}/releases?per_page=50`;
  await execShell(cn, `mkdir -p ${spec.appDir}`, { timeout: 10_000 });

  // Read the configured release branch from Spine config
  let releaseBranch = '';
  try {
    const { settingsService } = await import('../settings');
    const config = await settingsService.getRaw();
    releaseBranch = config.release_branch || '';
  } catch { /* default to main */ }

  // Validate release branch — only alphanumeric + hyphen/underscore to prevent shell injection
  const safeBranch = (releaseBranch && releaseBranch !== 'main' && /^[a-zA-Z0-9_-]+$/.test(releaseBranch))
    ? releaseBranch
    : '';

  // Build Python filter that respects release branch and tag prefix
  const branchFilter = `branch='${safeBranch}'`;
  const tagPrefixFilter = `tag_prefix='${cfg.tagPrefix || ''}'`;

  const downloadScript = `
    set -e

    # Wait for DNS/network to be ready (GitHub API must resolve and respond)
    echo "Waiting for network readiness..."
    for i in 1 2 3 4 5 6 7 8 9 10; do
      if curl -sSf -o /dev/null -w '' -H 'User-Agent: YouEye-Installer' 'https://api.github.com/rate_limit' 2>/dev/null; then
        echo "Network ready (attempt \$i)"
        break
      fi
      echo "Network not ready, waiting... (attempt \$i)"
      sleep 3
    done

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

    fetch_release_url() {
      HTTP_CODE=\$(curl -sSL -o /tmp/releases.json -w '%{http_code}' -H 'Accept: application/vnd.github+json' -H 'User-Agent: YouEye-Installer' '${releasesURL}')

      if [ "\$HTTP_CODE" != "200" ]; then
        echo "GitHub API returned HTTP \$HTTP_CODE" >&2
        head -5 /tmp/releases.json >&2
        return 1
      fi

      python3 -c "
import json, re
${branchFilter}
${tagPrefixFilter}
with open('/tmp/releases.json') as f:
    releases = json.load(f)

def parse_ver(v):
    return [int(x) for x in v.split('.')]

def ver_gt(a, b):
    pa, pb = parse_ver(a), parse_ver(b)
    for i in range(max(len(pa), len(pb))):
        va = pa[i] if i < len(pa) else 0
        vb = pb[i] if i < len(pb) else 0
        if va != vb: return va > vb
    return False

best_branch_url = None
best_branch_ver = None
best_main_url = None
best_main_ver = None

for r in releases:
    tag = r['tag_name']
    stripped = tag
    if tag_prefix:
        pfx = tag_prefix + '-'
        if not tag.startswith(pfx):
            continue
        stripped = tag[len(pfx):]
    tar_url = None
    for a in r['assets']:
        if a['name'] == 'standalone.tar':
            tar_url = a['browser_download_url']
            break
    if not tar_url:
        continue
    if branch and stripped.startswith(branch + '-v'):
        ver = stripped[len(branch)+2:]
        if best_branch_ver is None or ver_gt(ver, best_branch_ver):
            best_branch_ver = ver
            best_branch_url = tar_url
    elif re.match(r'^v\d', stripped):
        ver = stripped[1:]
        if best_main_ver is None or ver_gt(ver, best_main_ver):
            best_main_ver = ver
            best_main_url = tar_url

url = None
if best_branch_ver and best_main_ver:
    url = best_main_url if ver_gt(best_main_ver, best_branch_ver) else best_branch_url
elif best_branch_ver:
    url = best_branch_url
elif best_main_ver:
    url = best_main_url

if url:
    print(url)
else:
    print(f'No matching release found (tag_prefix={tag_prefix!r}, branch={branch!r}, total_releases={len(releases)}, type={type(releases).__name__})', file=sys.stderr)
    if isinstance(releases, list):
        for r in releases[:5]:
            if isinstance(r, dict):
                t = r.get('tag_name', '?')
                a = [x['name'] for x in r.get('assets', [])]
                print(f'  tag={t}, assets={a}', file=sys.stderr)
            else:
                print(f'  unexpected item: {str(r)[:100]}', file=sys.stderr)
    elif isinstance(releases, dict):
        print(f'  API response is dict (rate limit?): {str(releases)[:200]}', file=sys.stderr)
    sys.exit(1)
"
    }

    DOWNLOAD_URL=$(retry 3 5 fetch_release_url)

    if [ -z "$DOWNLOAD_URL" ]; then
      echo "ERROR: Could not find standalone.tar in releases after retries"
      exit 1
    fi

    echo "Downloading from: $DOWNLOAD_URL"
    curl -sSL "$DOWNLOAD_URL" -o /tmp/app.tar
    tar -xf /tmp/app.tar -C ${spec.appDir} --no-same-owner
    rm /tmp/app.tar

    # Verify the download actually produced the app
    if [ ! -f "${spec.appDir}/${spec.entryFile ?? 'server.js'}" ]; then
      echo "ERROR: Download completed but ${spec.entryFile ?? 'server.js'} not found in ${spec.appDir}"
      ls -la ${spec.appDir}
      exit 1
    fi
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
ExecStart=/usr/bin/node ${spec.appDir}/${spec.entryFile ?? 'server.js'}
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
  await execShell(cn, `systemctl enable --now ${serviceName}`, { timeout: 15_000 });
}
