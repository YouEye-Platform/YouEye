/**
 * Shared Incus Snapshot & Container Operations
 *
 * Reusable helpers for snapshot-based update workflows across OCI and LXD updaters.
 * All operations go through the Incus REST API via unix socket.
 */

import { incusRequest, execShell } from './server';

// ─── Operation Helpers ───────────────────────────────────────────────────────

export async function waitForOperation(operationPath: string, timeoutSeconds = 300): Promise<void> {
  const waitPath = `${operationPath}/wait?timeout=${timeoutSeconds}`;
  const resp = await incusRequest<Record<string, unknown>>('GET', waitPath, undefined, {
    timeout: (timeoutSeconds + 30) * 1000,
  });
  const meta = resp.metadata as Record<string, unknown> | undefined;
  if (!meta) return;
  if ((meta.status as string) === 'Failure') {
    throw new Error(`Operation failed: ${(meta.err as string) || 'unknown'}`);
  }
}

// ─── Container State ─────────────────────────────────────────────────────────

export async function containerState(name: string): Promise<string> {
  try {
    const resp = await incusRequest<Record<string, unknown>>('GET', `/1.0/instances/${name}/state`);
    return ((resp.metadata as Record<string, unknown>)?.status as string) ?? 'Unknown';
  } catch {
    return 'Unknown';
  }
}

export async function stopContainer(name: string): Promise<void> {
  if ((await containerState(name)) !== 'Running') return;
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}/state`,
    { action: 'stop', force: true, timeout: 30 }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
}

export async function startContainer(name: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}/state`,
    { action: 'start' }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
}

export async function waitForRunning(name: string, maxWait = 30): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    const state = await containerState(name);
    if (state === 'Running') return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container ${name} did not reach Running state within ${maxWait}s`);
}

export async function waitForContainerExec(name: string, maxWait = 30): Promise<void> {
  for (let i = 0; i < maxWait; i++) {
    try {
      const result = await execShell(name, 'echo ready', { timeout: 5000 });
      if (result.stdout.trim() === 'ready') return;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Container ${name} did not become exec-ready within ${maxWait}s`);
}

// ─── Snapshot Operations ─────────────────────────────────────────────────────

export async function createSnapshot(name: string, snapshotName: string): Promise<void> {
  // Delete existing snapshot with the same name (ignore errors)
  try {
    await incusRequest('DELETE', `/1.0/instances/${name}/snapshots/${snapshotName}`);
    await new Promise((r) => setTimeout(r, 1000));
  } catch {
    // fine — snapshot didn't exist
  }

  const resp = await incusRequest<Record<string, unknown>>(
    'POST', `/1.0/instances/${name}/snapshots`,
    { name: snapshotName, stateful: false }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 120);
}

export async function restoreSnapshot(name: string, snapshotName: string): Promise<void> {
  const resp = await incusRequest<Record<string, unknown>>(
    'PUT', `/1.0/instances/${name}`,
    { restore: snapshotName }
  );
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 300);
}

export async function deleteSnapshot(name: string, snapshotName: string): Promise<void> {
  try {
    const resp = await incusRequest<Record<string, unknown>>(
      'DELETE', `/1.0/instances/${name}/snapshots/${snapshotName}`
    );
    if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 60);
  } catch {
    // non-critical
  }
}

// ─── OCI Container Operations ────────────────────────────────────────────────

/**
 * Parse an OCI image reference into Incus source format.
 * Examples:
 *   "caddy" → { server: "https://docker.io", alias: "library/caddy" }
 *   "ghcr.io/foo/bar:v1" → { server: "https://ghcr.io", alias: "foo/bar:v1" }
 */
export function parseOCIImage(image: string): { server: string; protocol: string; alias: string } {
  const parts = image.split('/');
  if (parts.length === 1) {
    return { server: 'https://docker.io', protocol: 'oci', alias: `library/${image}` };
  }
  const serverPart = parts[0];
  const alias = parts.slice(1).join('/');
  return { server: `https://${serverPart}`, protocol: 'oci', alias };
}

/**
 * Rebuild an existing container with a new OCI image.
 * Uses Incus 6.x rebuild API — preserves volumes and config.
 * IMPORTANT: Snapshots must be deleted before rebuild (Incus requirement).
 */
export async function rebuildContainer(name: string, image: string): Promise<void> {
  const source = parseOCIImage(image);

  const resp = await incusRequest<Record<string, unknown>>(
    'POST', `/1.0/instances/${name}/rebuild`,
    {
      source: {
        type: 'image',
        mode: 'pull',
        ...source,
      },
    },
    { timeout: 660_000 } // 11 min for image download
  );

  if (resp.error && resp.error !== '') throw new Error(`Rebuild failed: ${resp.error}`);
  if (resp.type === 'async' && resp.operation) await waitForOperation(resp.operation, 600);
}

// ─── LXD Service Helpers ─────────────────────────────────────────────────────

/**
 * Read the real WorkingDirectory from a systemd unit inside a container.
 * Uses `systemctl show` which handles drop-in overrides correctly.
 */
export async function getServiceWorkingDir(
  containerName: string,
  serviceName: string,
  fallbackDir: string
): Promise<string> {
  try {
    const result = await execShell(
      containerName,
      `systemctl show ${serviceName} -p WorkingDirectory --value`,
      { timeout: 10_000 }
    );
    const resolved = result.stdout?.trim();
    if (resolved && resolved !== '' && resolved !== '(null)') {
      return resolved;
    }
  } catch {
    // systemctl show failed — fall back to configured dir
  }
  return fallbackDir;
}

/**
 * Run apt update + upgrade inside an LXD container.
 * Non-interactive to prevent dpkg prompts blocking.
 */
export async function upgradeContainerOS(containerName: string): Promise<void> {
  await execShell(
    containerName,
    'apt-get update -q && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -q --no-install-recommends',
    { timeout: 300_000 } // 5 min for slow mirrors
  );
}

/**
 * Health check via curl inside a container.
 * Accepts 200, 401 (auth-gated but running), 302 (redirect, app running).
 */
export async function healthCheckViaExec(
  containerName: string,
  port: number,
  endpoint: string,
  maxAttempts: number
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const result = await execShell(
        containerName,
        `curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}${endpoint}`,
        { timeout: 10_000 }
      );
      const code = result.stdout.trim().replace(/'/g, '');
      if (code === '200' || code === '401' || code === '302') return;
    } catch { /* not ready yet */ }
  }
  throw new Error(`Health check failed after ${maxAttempts} attempts on port ${port}${endpoint}`);
}
