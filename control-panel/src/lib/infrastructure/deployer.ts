/**
 * Main infrastructure deployment orchestrator.
 * Called from the SSE API endpoint. Deploys all infrastructure apps in order,
 * emitting progress events for each step.
 */

import type { DeploymentEvent } from './types';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import {
  caddyManifest,
  piholeManifest,
  postgresManifest,
  authentikServerManifest,
  authentikWorkerManifest,
  uiContainerSpec,
} from './manifests';
import { getOrCreateSecret, generatePassword } from './secrets';
import { deployOCIContainer, containerExists } from './oci-deployer';
import { getSystemStaticIP, getSubnetBase } from '../incus/static-ips';
import { deployLXDContainer } from './lxd-deployer';
import { waitForPostgres, waitForAuthentik, waitForCaddy, waitForPiHole } from './health-checks';
import { setupAuthentikDatabase } from './postgres-setup';
import { createAuthentikAPIToken, setupCaddyAuthentikRoute } from './authentik-setup';
import { setDefaultRoute, ensurePingRoute, setContainerRoute } from '../caddy/client';
import { settingsService } from '../settings';
import { execShell } from '../incus/server';
import { applyResourcePolicy } from './resource-policy';

const TOTAL_STEPS = 8;
const PIHOLE_CONTAINER = 'youeye-pihole';

/**
 * Set Pi-Hole password via CLI exec after container is healthy.
 * This avoids the FTL v6 env var lock that blocks `pihole setpassword`
 * when FTLCONF_webserver_api_password is set as a container env var.
 */
async function setPiholePasswordViaExec(password: string): Promise<void> {
  const result = await execShell(PIHOLE_CONTAINER, `pihole setpassword ${password}`);
  if (result.exitCode !== 0) {
    throw new Error(`pihole setpassword failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

type EventCallback = (event: DeploymentEvent) => void;

function emit(cb: EventCallback, step: number, status: DeploymentEvent['status'], message: string, detail?: string) {
  cb({ step, totalSteps: TOTAL_STEPS, status, message, detail });
}

/**
 * Run the full infrastructure deployment.
 * @param hostIP - The host's primary IP address (passed from Spine).
 * @param onEvent - Callback for each deployment progress event (sent as SSE).
 */
export async function deployInfrastructure(
  hostIP: string,
  onEvent: EventCallback
): Promise<void> {
  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  emit(onEvent, 1, 'running', 'Deploying PostgreSQL database...');
  try {
    const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
    const manifest = postgresManifest(pgPassword);
    await deployOCIContainer(manifest, '');
    await applyResourcePolicy('youeye-postgres', 'critical');

    const healthy = await waitForPostgres();
    if (!healthy) {
      emit(onEvent, 1, 'error', 'PostgreSQL health check failed', 'Container deployed but not accepting connections');
      return;
    }
    emit(onEvent, 1, 'success', 'PostgreSQL deployed and accepting connections');
  } catch (err) {
    emit(onEvent, 1, 'error', 'PostgreSQL deployment failed', String(err));
    return; // Cannot continue without database
  }

  // ─── Step 2: Authentik database setup ───────────────────────
  emit(onEvent, 2, 'running', 'Setting up Authentik database...');
  let authentikSecrets: Awaited<ReturnType<typeof setupAuthentikDatabase>>;
  try {
    authentikSecrets = await setupAuthentikDatabase();
    emit(onEvent, 2, 'success', 'Authentik database and secrets ready');
  } catch (err) {
    emit(onEvent, 2, 'error', 'Authentik database setup failed', String(err));
    return;
  }

  // ─── Step 3: Authentik server ──────────────────────────────
  emit(onEvent, 3, 'running', 'Deploying Authentik identity provider (this may take several minutes)...');
  try {
    const postgresIP = await getSystemStaticIP('youeye-postgres');
    if (!postgresIP) throw new Error('Cannot get PostgreSQL container IP');

    const serverManifest = authentikServerManifest(
      postgresIP,
      authentikSecrets.dbPassword,
      authentikSecrets.secretKey,
      authentikSecrets.bootstrapPassword,
      authentikSecrets.bootstrapToken
    );
    await deployOCIContainer(serverManifest, '');
    await applyResourcePolicy('youeye-authentik', 'critical');

    const healthy = await waitForAuthentik();
    emit(onEvent, 3, healthy ? 'success' : 'error',
      healthy ? 'Authentik server is healthy' : 'Authentik health check timed out (continuing — it may still be starting)');
    // Don't return on timeout — Authentik is slow to start but deployment can continue.
    // Caddy, Pi-Hole, and UI don't depend on Authentik being immediately healthy.
  } catch (err) {
    emit(onEvent, 3, 'error', 'Authentik deployment failed', String(err));
    return;
  }

  // ─── Step 4: Authentik worker ─────────────────────────────
  emit(onEvent, 4, 'running', 'Deploying Authentik worker...');
  try {
    const postgresIP = await getSystemStaticIP('youeye-postgres');
    if (!postgresIP) throw new Error('Cannot get PostgreSQL container IP');

    const workerManifest = authentikWorkerManifest(
      postgresIP,
      authentikSecrets.dbPassword,
      authentikSecrets.secretKey,
      authentikSecrets.bootstrapPassword,
      authentikSecrets.bootstrapToken
    );
    await deployOCIContainer(workerManifest, '');
    await applyResourcePolicy('youeye-authentik-worker', 'critical');
    emit(onEvent, 4, 'success', 'Authentik worker deployed');
  } catch (err) {
    // Worker failure is critical — without it, akadmin user and bootstrap token
    // are never created, and the setup wizard cannot configure Authentik
    emit(onEvent, 4, 'error', 'Authentik worker deployment failed — setup will not complete', String(err));
    return;
  }

  // ─── Step 5: Authentik API token ──────────────────────────
  emit(onEvent, 5, 'running', 'Creating Authentik API token...');
  try {
    await createAuthentikAPIToken();
    emit(onEvent, 5, 'success', 'Authentik API token created');
  } catch (err) {
    emit(onEvent, 5, 'error', 'Could not create API token (will retry later)', String(err));
  }

  // ─── Step 6: Caddy reverse proxy ─────────────────────────
  emit(onEvent, 6, 'running', 'Deploying Caddy reverse proxy...');
  try {
    const manifest = caddyManifest();
    await deployOCIContainer(manifest, hostIP);
    await applyResourcePolicy('youeye-caddy', 'critical');

    const healthy = await waitForCaddy();
    if (healthy) {
      // Configure admin API to accept requests from any origin.
      // By default, Caddy rejects non-localhost origins when admin listens on 0.0.0.0,
      // but CP needs admin API access via Incus network to manage routes.
      try {
        // Use static IP for the CP upstream — Caddy OCI containers have
        // multiple NICs from per-app bridges, and their DNS resolver picks
        // a per-app bridge dnsmasq that doesn't know about system container
        // names. Static IPs bypass DNS entirely.
        const controlIP = await getSystemStaticIP('youeye-control') || `youeye-control.${CONTAINER_DOMAIN}`;
        const caddyfile = [
          '{',
          '    admin 0.0.0.0:2019 {',
          '        origins *',
          '    }',
          '    on_demand_tls {',
          `        ask http://${controlIP}:3000/api/setup/config`,
          '    }',
          '}',
          '',
          ':443 {',
          '    tls {',
          '        on_demand',
          '        issuer internal',
          '    }',
          `    reverse_proxy ${controlIP}:3000`,
          '}',
          '',
        ].join('\n');
        const b64 = Buffer.from(caddyfile).toString('base64');
        await execShell('youeye-caddy',
          `echo '${b64}' | base64 -d > /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
          { timeout: 15000 }
        );
      } catch {
        // Non-fatal but all route management will fail
        console.error('[deploy] Failed to configure Caddy admin API origins');
      }

      // Setup Authentik route if both are running
      if (await containerExists('youeye-authentik')) {
        try {
          await setupCaddyAuthentikRoute();
        } catch (err) {
          // Non-fatal — route can be added later
          emit(onEvent, 6, 'success', 'Caddy deployed (Authentik route setup deferred)', String(err));
          // Don't return, continue
        }
      }
    }
    emit(onEvent, 6, healthy ? 'success' : 'error',
      healthy ? 'Caddy deployed with Authentik route' : 'Caddy health check timed out');
    
    // Add default catch-all route for IP-based access (proxies to CP for setup flow)
    if (healthy) {
      try {
        await setDefaultRoute('youeye-control', 3000);
      } catch (err) {
        console.error('Failed to set default catch-all route:', err);
      }
      // BUG-022: Ensure /api/ping route so Spine health checks work on any domain
      try {
        await ensurePingRoute('youeye-control', 3000);
      } catch (err) {
        console.error('Failed to set /api/ping route:', err);
      }
    }
  } catch (err) {
    emit(onEvent, 6, 'error', 'Caddy deployment failed', String(err));
  }

  // ─── Step 7: Pi-Hole DNS ─────────────────────────────────
  emit(onEvent, 7, 'running', 'Deploying Pi-Hole DNS...');
  try {
    const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
    const manifest = piholeManifest(hostIP);
    await deployOCIContainer(manifest, hostIP);
    await applyResourcePolicy('youeye-pihole', 'critical');

    const healthy = await waitForPiHole();
    if (healthy) {
      // Set password via CLI after container is healthy. We intentionally
      // do NOT bake the password into the container env var because FTL v6
      // locks out `pihole setpassword` when FTLCONF_webserver_api_password
      // is set, which breaks password changes and the resync recovery path.
      await setPiholePasswordViaExec(webPassword);
    }
    emit(onEvent, 7, healthy ? 'success' : 'error',
      healthy ? 'Pi-Hole deployed and responding' : 'Pi-Hole may still be initializing');
  } catch (err) {
    emit(onEvent, 7, 'error', 'Pi-Hole deployment failed', String(err));
  }

  // ─── Step 8: YouEye UI ───────────────────────────────────
  emit(onEvent, 8, 'running', 'Deploying YouEye UI container...');
  try {
    const spec = uiContainerSpec();
    await deployLXDContainer(spec, {
      spineSocketPath: '/var/run/youeye/youeye.sock',
      giteaBaseURL: 'https://git.byka.wtf',
      giteaOrg: 'potemsla',
      giteaRepo: 'YouEye',
      tagPrefix: 'ui',
    });
    await applyResourcePolicy('youeye-ui', 'critical');
    emit(onEvent, 8, 'success', 'YouEye UI container deployed');
  } catch (err) {
    emit(onEvent, 8, 'error', 'UI container deployment failed', String(err));
  }

}


/**
 * Reconcile infrastructure by deploying only MISSING containers.
 * Called after `spine update control` to ensure infrastructure is intact.
 * Unlike deployInfrastructure(), this does NOT destroy existing containers —
 * it only creates containers that don't exist yet.
 *
 * @param hostIP - The host's primary IP address.
 * @param onEvent - Callback for each progress event (sent as SSE).
 */
export async function reconcileInfrastructure(
  hostIP: string,
  onEvent: EventCallback
): Promise<void> {
  const RECONCILE_STEPS = 6; // postgres, authentik, authentik-worker, caddy, pihole, ui

  function remit(step: number, status: DeploymentEvent['status'], message: string, detail?: string) {
    onEvent({ step, totalSteps: RECONCILE_STEPS, status, message, detail });
  }

  // Check which containers are missing
  const containers = [
    'youeye-postgres',
    'youeye-authentik',
    'youeye-authentik-worker',
    'youeye-caddy',
    'youeye-pihole',
    'youeye-ui',
  ];

  const missing: string[] = [];
  for (const name of containers) {
    if (!(await containerExists(name))) {
      missing.push(name);
    }
  }

  if (missing.length === 0) {
    remit(1, 'success', 'All infrastructure containers are present — nothing to reconcile');
    return;
  }

  console.log(`[reconcile] Missing containers: ${missing.join(', ')}`);

  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  if (missing.includes('youeye-postgres')) {
    remit(1, 'running', 'Deploying missing PostgreSQL database...');
    try {
      const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
      const manifest = postgresManifest(pgPassword);
      await deployOCIContainer(manifest, '');
      await applyResourcePolicy('youeye-postgres', 'critical');
      const healthy = await waitForPostgres();
      if (!healthy) {
        remit(1, 'error', 'PostgreSQL health check failed');
        return; // Cannot continue without database
      }
      remit(1, 'success', 'PostgreSQL deployed and accepting connections');
    } catch (err) {
      remit(1, 'error', 'PostgreSQL deployment failed', String(err));
      return;
    }
  } else {
    remit(1, 'skipped', 'PostgreSQL already running');
  }

  // ─── Step 2: Authentik server ──────────────────────────────
  if (missing.includes('youeye-authentik')) {
    remit(2, 'running', 'Deploying missing Authentik server...');
    try {
      // Ensure Authentik DB is set up (idempotent)
      const authentikSecrets = await setupAuthentikDatabase();
      const postgresIP = await getSystemStaticIP('youeye-postgres');
      if (!postgresIP) throw new Error('Cannot get PostgreSQL container IP');

      const serverManifest = authentikServerManifest(
        postgresIP,
        authentikSecrets.dbPassword,
        authentikSecrets.secretKey,
        authentikSecrets.bootstrapPassword,
        authentikSecrets.bootstrapToken
      );
      await deployOCIContainer(serverManifest, '');
      await applyResourcePolicy('youeye-authentik', 'critical');
      const healthy = await waitForAuthentik();
      remit(2, healthy ? 'success' : 'error',
        healthy ? 'Authentik server deployed' : 'Authentik deployed but health check timed out');
    } catch (err) {
      remit(2, 'error', 'Authentik deployment failed', String(err));
    }
  } else {
    remit(2, 'skipped', 'Authentik already running');
  }

  // ─── Step 3: Authentik worker ─────────────────────────────
  if (missing.includes('youeye-authentik-worker')) {
    remit(3, 'running', 'Deploying missing Authentik worker...');
    try {
      const authentikSecrets = await setupAuthentikDatabase();
      const postgresIP = await getSystemStaticIP('youeye-postgres');
      if (!postgresIP) throw new Error('Cannot get PostgreSQL container IP');

      const workerManifest = authentikWorkerManifest(
        postgresIP,
        authentikSecrets.dbPassword,
        authentikSecrets.secretKey,
        authentikSecrets.bootstrapPassword,
        authentikSecrets.bootstrapToken
      );
      await deployOCIContainer(workerManifest, '');
      await applyResourcePolicy('youeye-authentik-worker', 'critical');
      remit(3, 'success', 'Authentik worker deployed');
    } catch (err) {
      remit(3, 'error', 'Authentik worker deployment failed', String(err));
    }
  } else {
    remit(3, 'skipped', 'Authentik worker already running');
  }

  // ─── Step 4: Caddy reverse proxy ─────────────────────────
  if (missing.includes('youeye-caddy')) {
    remit(4, 'running', 'Deploying missing Caddy reverse proxy...');
    try {
      const manifest = caddyManifest();
      await deployOCIContainer(manifest, hostIP);
      await applyResourcePolicy('youeye-caddy', 'critical');
      const healthy = await waitForCaddy();
      if (healthy) {
        // Configure Caddy admin API origins — use static IP (see step 6 comment)
        try {
          const controlIP = await getSystemStaticIP('youeye-control') || `youeye-control.${CONTAINER_DOMAIN}`;
          const caddyfile = [
            '{',
            '    admin 0.0.0.0:2019 {',
            '        origins *',
            '    }',
            '    on_demand_tls {',
            `        ask http://${controlIP}:3000/api/setup/config`,
            '    }',
            '}',
            '',
            ':443 {',
            '    tls {',
            '        on_demand',
            '        issuer internal',
            '    }',
            `    reverse_proxy ${controlIP}:3000`,
            '}',
            '',
          ].join('\n');
          const b64 = Buffer.from(caddyfile).toString('base64');
          await execShell('youeye-caddy',
            `echo '${b64}' | base64 -d > /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
            { timeout: 15000 }
          );
        } catch {
          console.error('[reconcile] Failed to configure Caddy admin API origins');
        }

        // Setup Authentik route if available
        if (await containerExists('youeye-authentik')) {
          try { await setupCaddyAuthentikRoute(); } catch { /* deferred */ }
        }

        // Add default catch-all route
        try { await setDefaultRoute('youeye-control', 3000); } catch { /* non-fatal */ }
        // BUG-022: Ensure /api/ping route
        try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }
      }
      remit(4, healthy ? 'success' : 'error',
        healthy ? 'Caddy deployed and configured' : 'Caddy deployed but health check timed out');
    } catch (err) {
      remit(4, 'error', 'Caddy deployment failed', String(err));
    }
  } else {
    remit(4, 'skipped', 'Caddy already running');
    // BUG-022: Ensure /api/ping route even when Caddy was already running.
    // This handles upgrades from versions that didn't have the ping route.
    try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }
  }

  // ─── Step 5: Pi-Hole DNS ─────────────────────────────────
  if (missing.includes('youeye-pihole')) {
    remit(5, 'running', 'Deploying missing Pi-Hole DNS...');
    try {
      const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
      const manifest = piholeManifest(hostIP);
      await deployOCIContainer(manifest, hostIP);
      await applyResourcePolicy('youeye-pihole', 'critical');
      const healthy = await waitForPiHole();
      if (healthy) {
        await setPiholePasswordViaExec(webPassword);
      }
      remit(5, healthy ? 'success' : 'error',
        healthy ? 'Pi-Hole deployed and responding' : 'Pi-Hole deployed but may still be initializing');
    } catch (err) {
      remit(5, 'error', 'Pi-Hole deployment failed', String(err));
    }
  } else {
    remit(5, 'skipped', 'Pi-Hole already running');
  }

  // ─── Step 6: YouEye UI ───────────────────────────────────
  if (missing.includes('youeye-ui')) {
    remit(6, 'running', 'Deploying missing YouEye UI container...');
    try {
      const spec = uiContainerSpec();
      await deployLXDContainer(spec, {
        spineSocketPath: '/var/run/youeye/youeye.sock',
        giteaBaseURL: 'https://git.byka.wtf',
        giteaOrg: 'potemsla',
        giteaRepo: 'YouEye',
        tagPrefix: 'ui',
      });
      await applyResourcePolicy('youeye-ui', 'critical');
      remit(6, 'success', 'YouEye UI container deployed');
    } catch (err) {
      remit(6, 'error', 'UI container deployment failed', String(err));
    }
  } else {
    remit(6, 'skipped', 'YouEye UI already running');
  }

}
