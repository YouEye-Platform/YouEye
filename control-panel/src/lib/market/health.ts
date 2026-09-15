/**
 * Health check utilities for market app containers.
 * Waits for containers to become responsive after deployment.
 */

import { getContainerIP } from '../infrastructure/oci-deployer';

/**
 * Wait for an app to respond on its HTTP port.
 * Accepts 2xx, 3xx, 401, 403 as healthy. Rejects 5xx as unhealthy.
 */
export async function waitForAppHealth(
  containerName: string,
  port: number,
  path = '/',
  timeoutMs = 120_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  // Give the container a few seconds to start
  await new Promise((r) => setTimeout(r, 3000));

  while (Date.now() < deadline) {
    const ip = await getContainerIP(containerName);
    if (ip) {
      try {
        const resp = await fetch(`http://${ip}:${port}${path}`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.status < 500) return true;
      } catch {
        // Not ready yet
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}

/**
 * Wait for PostgreSQL to accept connections inside a container.
 */
export async function waitForPostgresHealth(
  containerName: string,
  user = 'postgres',
  timeoutMs = 60_000
): Promise<boolean> {
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(user)) {
    throw new Error(`Invalid PostgreSQL health-check user: ${user}`);
  }

  const { execCommand } = await import('../incus/server');
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'PostgreSQL did not accept the probe';

  while (Date.now() < deadline) {
    for (const executable of ['/usr/local/bin/pg_isready', '/usr/bin/pg_isready']) {
      try {
        const result = await execCommand(containerName, [executable, '-U', user], {
          timeout: 5000,
        });
        if (result.exitCode === 0) return true;
        lastFailure = `${executable} exited with status ${result.exitCode}`;
        if (result.exitCode !== 127) break;
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : 'PostgreSQL probe failed';
        // Try the fallback path, then wait for PostgreSQL to become ready.
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  console.warn(`[market] PostgreSQL health probe timed out for ${containerName}: ${lastFailure}`);
  return false;
}
