/**
 * Health check functions for infrastructure services.
 * Each waits for a service to become responsive after deployment.
 */

import { execCommand } from '../incus/server';
import { getContainerIP } from './oci-deployer';

type HealthExec = typeof execCommand;

export async function repairThenVerify(
  service: string,
  probe: (stage: 'initial' | 'after-repair') => Promise<boolean>,
  repair: () => Promise<void>,
): Promise<'healthy' | 'repaired'> {
  if (await probe('initial')) return 'healthy';
  await repair();
  if (!(await probe('after-repair'))) {
    throw new Error(`${service} remained unhealthy after reconciliation repair`);
  }
  return 'repaired';
}

/**
 * Verify that a full-OS application container has both an active systemd
 * service and a responsive local HTTP health endpoint. A RUNNING Incus
 * instance alone is not evidence that the application was installed.
 */
export async function probeLXDServiceHTTP(
  containerName: string,
  serviceName: string,
  port: number,
  endpoint: string,
  exec: HealthExec = execCommand,
): Promise<boolean> {
  try {
    const service = await exec(containerName, [
      '/usr/bin/systemctl', 'is-active', `${serviceName}.service`,
    ], { timeout: 5000 });
    if (service.exitCode !== 0 || service.stdout.trim() !== 'active') return false;

    const response = await exec(containerName, [
      '/usr/bin/curl', '--silent', '--show-error', '--fail',
      '--max-time', '5', `http://127.0.0.1:${port}${endpoint}`,
    ], { timeout: 7000 });
    return response.exitCode === 0;
  } catch {
    return false;
  }
}

export async function waitForYouEyeUI(
  containerName = 'youeye-ui',
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeLXDServiceHTTP(containerName, 'youeye-ui', 3000, '/api/health')) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

/**
 * Wait for PostgreSQL to accept an authenticated query using the persisted
 * application credential. A socket accepting unauthenticated readiness probes
 * is not sufficient evidence that the configured database is usable.
 */
export async function waitForPostgres(
  password: string,
  containerName = 'youeye-postgres',
  timeoutMs = 60_000,
  execute: typeof execCommand = execCommand,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await execute(containerName, [
        '/usr/local/bin/psql',
        '-h', '127.0.0.1',
        '-U', 'youeye',
        '-d', 'youeye',
        '-tAc', 'SELECT 1',
      ], {
        environment: { PGPASSWORD: password },
        timeout: 5000,
      });
      if (result.exitCode === 0 && result.stdout.trim() === '1') return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * Reconcile PostgreSQL's persisted application role with the protected
 * platform credential. The official image only applies POSTGRES_PASSWORD to a
 * fresh data directory, so recreating a container around retained data cannot
 * repair a password mismatch by itself.
 *
 * The credential is supplied through the Incus exec environment as base64 and
 * never appears in the command arguments or SQL text. The local socket is used
 * deliberately for this one repair operation; subsequent health probes use
 * TCP and therefore prove password authentication.
 */
export async function reconcilePostgresCredential(
  password: string,
  containerName = 'youeye-postgres',
  timeoutMs = 60_000,
  execute: typeof execCommand = execCommand,
): Promise<void> {
  if (!password) throw new Error('PostgreSQL credential is empty');
  const deadline = Date.now() + timeoutMs;
  const encodedPassword = Buffer.from(password, 'utf8').toString('base64');
  const sql = [
    'DO $youeye$',
    'BEGIN',
    "  EXECUTE format('ALTER ROLE youeye PASSWORD %L',",
    "    convert_from(decode(current_setting('youeye.bootstrap_password'), 'base64'), 'UTF8'));",
    'END',
    '$youeye$;',
  ].join(' ');

  while (Date.now() < deadline) {
    try {
      const result = await execute(containerName, [
        '/usr/local/bin/psql',
        '-U', 'youeye',
        '-d', 'postgres',
        '-v', 'ON_ERROR_STOP=1',
        '-tAc', sql,
      ], {
        environment: {
          PGOPTIONS: `-c youeye.bootstrap_password=${encodedPassword}`,
        },
        timeout: 5000,
      });
      if (result.exitCode === 0) return;
    } catch { /* PostgreSQL may still be starting */ }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('PostgreSQL credential reconciliation timed out');
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
 * Wait for both Pi-Hole's web surface and its DNS resolver to respond.
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
        const [resp, dns] = await Promise.all([
          fetch(`http://${ip}:80/`, { signal: AbortSignal.timeout(3000) }),
          execCommand(containerName, [
            '/usr/bin/dig', '+short', '+time=2', '+tries=1',
            '@127.0.0.1', 'pi.hole', 'A',
          ], { timeout: 5000 }),
        ]);
        const webHealthy = resp.ok || resp.status === 301 || resp.status === 302 || resp.status === 403;
        const dnsHealthy = dns.exitCode === 0
          && dns.stdout.split(/\s+/).some((value) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value));
        if (webHealthy && dnsHealthy) return true;
      } catch { /* not ready */ }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
