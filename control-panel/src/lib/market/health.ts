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
  const { execShell } = await import('../incus/server');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await execShell(containerName, `pg_isready -U ${user}`, {
        timeout: 5000,
      });
      if (result.stdout.includes('accepting connections')) return true;
    } catch {
      // Not ready
    }
    await new Promise((r) => setTimeout(r, 2000));
  }

  return false;
}
