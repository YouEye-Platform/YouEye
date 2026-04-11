/**
 * Health check functions for infrastructure services.
 * Each waits for a service to become responsive after deployment.
 */

import { execShell } from '../incus/server';
import { getContainerIP } from './oci-deployer';

/**
 * Wait for PostgreSQL to accept connections.
 * Uses pg_isready inside the container.
 */
export async function waitForPostgres(
  containerName = 'youeye-postgres',
  timeoutMs = 60_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await execShell(containerName, 'pg_isready -U youeye -d youeye', {
        timeout: 5000,
      });
      if (result.stdout.includes('accepting connections')) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Wait for Authentik server health endpoint.
 * Authentik exposes /-/health/ready/ on port 9000.
 */
export async function waitForAuthentik(
  containerName = 'youeye-authentik',
  timeoutMs = 180_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await getContainerIP(containerName);
    if (ip) {
      try {
        const resp = await fetch(`http://${ip}:9000/-/health/ready/`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) return true;
      } catch { /* not healthy yet */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Wait for Caddy admin API to respond.
 * Caddy admin API listens on port 2019 inside the container.
 */
export async function waitForCaddy(
  containerName = 'youeye-caddy',
  timeoutMs = 120_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Let Incus settle after container creation before polling
  await new Promise((r) => setTimeout(r, 3000));
  while (Date.now() < deadline) {
    const ip = await getContainerIP(containerName);
    if (ip) {
      try {
        const resp = await fetch(`http://${ip}:2019/config/`, {
          signal: AbortSignal.timeout(5000),
        });
        // Any HTTP response (including 403) means Caddy is running.
        // Admin API returns 403 for non-localhost origins which is expected.
        if (resp.ok || resp.status === 403) return true;
      } catch { /* not ready */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Wait for Pi-Hole web interface to respond (port 80).
 */
export async function waitForPiHole(
  containerName = 'youeye-pihole',
  timeoutMs = 180_000
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  // Pi-Hole needs a few seconds to initialize
  await new Promise((r) => setTimeout(r, 5000));

  while (Date.now() < deadline) {
    const ip = await getContainerIP(containerName);
    if (ip) {
      try {
        const resp = await fetch(`http://${ip}:80/`, {
          signal: AbortSignal.timeout(3000),
        });
        // Any HTTP response means Pi-Hole is running.
        // Pi-Hole v6+ returns 403 for unauthenticated requests.
        if (resp.ok || resp.status === 301 || resp.status === 302 || resp.status === 403) return true;
      } catch { /* not ready */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
