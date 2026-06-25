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
  uiContainerSpec,
} from './manifests';
import { getOrCreateSecret, generatePassword } from './secrets';
import { deployOCIContainer, containerExists } from './oci-deployer';
import { getSystemStaticIP } from '../incus/static-ips';
import { deployLXDContainer } from './lxd-deployer';
import { waitForPostgres, waitForCaddy, waitForPiHole } from './health-checks';
import { setDefaultRoute, ensurePingRoute, ensureHeaderStrippingRoute } from '../caddy/client';
import { execShell } from '../incus/server';
import { applyResourcePolicy } from './resource-policy';
import { applySystemImage, recordSystemContainerManifest, resolveSystemImageOverrides } from './system-market-manifests';
import { getReleaseSource } from '../apps/release-source';

const TOTAL_STEPS = 4;
const PIHOLE_CONTAINER = 'youeye-pihole';

/**
 * Deployment-in-progress flag. Background update checkers (update-cache,
 * version-checker) skip their work while this is true to avoid exhausting
 * GitHub's unauthenticated API rate limit (60 req/hr) before the UI
 * download step can run.
 */
let _deploying = false;
export function isDeploymentInProgress(): boolean { return _deploying; }

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

async function deployUIContainerFromConfiguredSource(): Promise<void> {
  const spec = uiContainerSpec();
  const releaseSource = await getReleaseSource();

  await deployLXDContainer(spec, {
    spineSocketPath: '/var/run/youeye/youeye.sock',
    giteaBaseURL: releaseSource.base_url,
    giteaOrg: releaseSource.organization,
    giteaRepo: releaseSource.repository || 'YouEye',
    tagPrefix: 'ui',
  });
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
  _deploying = true;
  try {
    await _deployInfrastructureInner(hostIP, onEvent);
  } finally {
    _deploying = false;
  }
}

async function _deployInfrastructureInner(
  hostIP: string,
  onEvent: EventCallback
): Promise<void> {
  let systemImages: Awaited<ReturnType<typeof resolveSystemImageOverrides>>;
  try {
    systemImages = await resolveSystemImageOverrides();
  } catch (err) {
    emit(onEvent, 1, 'error', 'Failed to load Market system app manifests', String(err));
    return;
  }

  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  emit(onEvent, 1, 'running', 'Deploying PostgreSQL database...');
  try {
    const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
    const manifest = applySystemImage(postgresManifest(pgPassword), systemImages.postgresql);
    await deployOCIContainer(manifest, '');
    await recordSystemContainerManifest('postgresql', systemImages.postgresql);
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

  // ─── Step 2: Caddy reverse proxy ─────────────────────────
  emit(onEvent, 2, 'running', 'Deploying Caddy reverse proxy...');
  try {
    const manifest = applySystemImage(caddyManifest(), systemImages.caddy);
    await deployOCIContainer(manifest, hostIP);
    await recordSystemContainerManifest('caddy', systemImages.caddy);
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

    }
    emit(onEvent, 2, healthy ? 'success' : 'error',
      healthy ? 'Caddy deployed' : 'Caddy health check timed out');
    
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
      // Security: Strip service-auth headers from all external requests
      try {
        await ensureHeaderStrippingRoute();
      } catch (err) {
        console.error('Failed to set header-stripping route:', err);
      }
    }
  } catch (err) {
    emit(onEvent, 2, 'error', 'Caddy deployment failed', String(err));
  }

  // ─── Step 3: Pi-Hole DNS ─────────────────────────────────
  emit(onEvent, 3, 'running', 'Deploying Pi-Hole DNS...');
  try {
    const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
    const manifest = applySystemImage(piholeManifest(hostIP), systemImages.pihole);
    await deployOCIContainer(manifest, hostIP);
    await recordSystemContainerManifest('pihole', systemImages.pihole);
    await applyResourcePolicy('youeye-pihole', 'critical');

    const healthy = await waitForPiHole();
    if (healthy) {
      // Set password via CLI after container is healthy. We intentionally
      // do NOT bake the password into the container env var because FTL v6
      // locks out `pihole setpassword` when FTLCONF_webserver_api_password
      // is set, which breaks password changes and the resync recovery path.
      await setPiholePasswordViaExec(webPassword);
    }
    emit(onEvent, 3, healthy ? 'success' : 'error',
      healthy ? 'Pi-Hole deployed and responding' : 'Pi-Hole may still be initializing');
  } catch (err) {
    emit(onEvent, 3, 'error', 'Pi-Hole deployment failed', String(err));
  }

  // ─── Step 4: YouEye UI ───────────────────────────────────
  emit(onEvent, 4, 'running', 'Deploying YouEye UI container...');
  try {
    await deployUIContainerFromConfiguredSource();
    await applyResourcePolicy('youeye-ui', 'critical');
    emit(onEvent, 4, 'success', 'YouEye UI container deployed');
  } catch (err) {
    emit(onEvent, 4, 'error', 'UI container deployment failed', String(err));
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
  const RECONCILE_STEPS = 4; // postgres, caddy, pihole, ui

  function remit(step: number, status: DeploymentEvent['status'], message: string, detail?: string) {
    onEvent({ step, totalSteps: RECONCILE_STEPS, status, message, detail });
  }

  // Check which containers are missing
  const containers = [
    'youeye-postgres',
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
    // Even when no containers need (re)deploying, re-ensure the security-critical Caddy routes.
    // These are idempotent and self-heal boxes that were set up before the routes existed —
    // notably the X-Youeye-* anti-spoof header-strip, which is otherwise only added on full
    // deploy/setup and was missing on already-provisioned boxes.
    try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }
    try { await ensureHeaderStrippingRoute(); } catch { /* non-fatal */ }
    remit(1, 'success', 'All infrastructure containers are present — security routes ensured');
    return;
  }

  console.log(`[reconcile] Missing containers: ${missing.join(', ')}`);

  let systemImages: Awaited<ReturnType<typeof resolveSystemImageOverrides>>;
  try {
    systemImages = await resolveSystemImageOverrides();
  } catch (err) {
    remit(1, 'error', 'Failed to load Market system app manifests', String(err));
    return;
  }

  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  if (missing.includes('youeye-postgres')) {
    remit(1, 'running', 'Deploying missing PostgreSQL database...');
    try {
      const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
      const manifest = applySystemImage(postgresManifest(pgPassword), systemImages.postgresql);
      await deployOCIContainer(manifest, '');
      await recordSystemContainerManifest('postgresql', systemImages.postgresql);
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

  // ─── Step 2: Caddy reverse proxy ─────────────────────────
  if (missing.includes('youeye-caddy')) {
    remit(2, 'running', 'Deploying missing Caddy reverse proxy...');
    try {
      const manifest = applySystemImage(caddyManifest(), systemImages.caddy);
      await deployOCIContainer(manifest, hostIP);
      await recordSystemContainerManifest('caddy', systemImages.caddy);
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

        // Add default catch-all route
        try { await setDefaultRoute('youeye-control', 3000); } catch { /* non-fatal */ }
        // BUG-022: Ensure /api/ping route
        try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }
        // Security: re-ensure the X-Youeye-* header-stripping route (anti-spoof) on reconcile
        try { await ensureHeaderStrippingRoute(); } catch { /* non-fatal */ }
      }
      remit(2, healthy ? 'success' : 'error',
        healthy ? 'Caddy deployed and configured' : 'Caddy deployed but health check timed out');
    } catch (err) {
      remit(2, 'error', 'Caddy deployment failed', String(err));
    }
  } else {
    remit(2, 'skipped', 'Caddy already running');
    // BUG-022: Ensure /api/ping route even when Caddy was already running.
    // This handles upgrades from versions that didn't have the ping route.
    try { await ensurePingRoute('youeye-control', 3000); } catch { /* non-fatal */ }
    // Security: re-ensure the X-Youeye-* header-stripping route (anti-spoof) even when Caddy was
    // already running. Self-heals boxes set up before this route existed, on every reconcile.
    try { await ensureHeaderStrippingRoute(); } catch { /* non-fatal */ }
  }

  // ─── Step 3: Pi-Hole DNS ─────────────────────────────────
  if (missing.includes('youeye-pihole')) {
    remit(3, 'running', 'Deploying missing Pi-Hole DNS...');
    try {
      const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
      const manifest = applySystemImage(piholeManifest(hostIP), systemImages.pihole);
      await deployOCIContainer(manifest, hostIP);
      await recordSystemContainerManifest('pihole', systemImages.pihole);
      await applyResourcePolicy('youeye-pihole', 'critical');
      const healthy = await waitForPiHole();
      if (healthy) {
        await setPiholePasswordViaExec(webPassword);
      }
      remit(3, healthy ? 'success' : 'error',
        healthy ? 'Pi-Hole deployed and responding' : 'Pi-Hole deployed but may still be initializing');
    } catch (err) {
      remit(3, 'error', 'Pi-Hole deployment failed', String(err));
    }
  } else {
    remit(3, 'skipped', 'Pi-Hole already running');
  }

  // ─── Step 4: YouEye UI ───────────────────────────────────
  if (missing.includes('youeye-ui')) {
    remit(4, 'running', 'Deploying missing YouEye UI container...');
    try {
      await deployUIContainerFromConfiguredSource();
      await applyResourcePolicy('youeye-ui', 'critical');
      remit(4, 'success', 'YouEye UI container deployed');
    } catch (err) {
      remit(4, 'error', 'UI container deployment failed', String(err));
    }
  } else {
    remit(4, 'skipped', 'YouEye UI already running');
  }

}
