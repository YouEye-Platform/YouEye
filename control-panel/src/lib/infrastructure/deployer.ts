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
  pointerContainerSpec,
  postgresManifest,
  uiContainerSpec,
} from './manifests';
import { getOrCreateSecret, generatePassword, readSecret } from './secrets';
import { deployOCIContainer, containerExists } from './oci-deployer';
import { getSystemStaticIP } from '../incus/static-ips';
import { deployLXDContainer, redeployLXDContainer } from './lxd-deployer';
import {
  repairThenVerify,
  waitForPostgres,
  reconcilePostgresCredential,
  waitForCaddy,
  waitForPiHole,
  waitForYouEyeUI,
} from './health-checks';
import {
  ensureHeaderStrippingRoute,
  ensurePingRoute,
  ensurePointerInferenceRoutes,
  setDefaultRoute,
} from '../caddy/client';
import { execShell } from '../incus/server';
import { applyResourcePolicy } from './resource-policy';
import { applySystemImage, recordSystemContainerManifest, resolveSystemImageOverrides } from './system-market-manifests';
import { getReleaseSource } from '../apps/release-source';
import { repairControlPanelProxy, repairUIEgressAcl } from './security-posture';
import { sanitizeDeploymentDetail } from './deployment-safety';
import { getCoreProvenance, recordCoreProvenance } from '@/lib/updates/provenance';
import { effectiveChannel } from '@/lib/updates/channels';
import {
  configurePointerService,
  deferPointerServiceUntilSetup,
  waitForPointer,
} from '../pointer/lifecycle';
import { settingsService } from '../settings';

const TOTAL_STEPS = 5;
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
  const result = await execShell(PIHOLE_CONTAINER, 'pihole setpassword "$YOUEYE_PIHOLE_PASSWORD"', {
    environment: { YOUEYE_PIHOLE_PASSWORD: password },
  });
  if (result.exitCode !== 0) {
    throw new Error(`pihole setpassword failed (exit ${result.exitCode}): ${result.stderr}`);
  }
}

type EventCallback = (event: DeploymentEvent) => void;

function emit(cb: EventCallback, step: number, status: DeploymentEvent['status'], message: string, detail?: string) {
  cb({
    step,
    totalSteps: TOTAL_STEPS,
    status,
    message,
    detail: detail ? sanitizeDeploymentDetail(detail) : undefined,
  });
}

class ReportedDeploymentError extends Error {}

function failDeployment(
  cb: EventCallback,
  step: number,
  message: string,
  detail?: unknown,
): never {
  const safeDetail = detail === undefined ? undefined : sanitizeDeploymentDetail(detail);
  emit(cb, step, 'error', message, safeDetail);
  throw new ReportedDeploymentError(safeDetail || message);
}

async function deployUIContainerFromConfiguredSource(replaceExisting = false): Promise<void> {
  const spec = uiContainerSpec();
  const releaseSource = await getReleaseSource();

  const deploy = replaceExisting ? redeployLXDContainer : deployLXDContainer;
  const resolved = await deploy(spec, {
    spineSocketPath: '/var/run/youeye/youeye.sock',
    giteaBaseURL: releaseSource.base_url,
    giteaOrg: releaseSource.organization,
    giteaRepo: releaseSource.repository || 'YouEye',
    releaseChannelKey: 'ui',
    tagPrefix: 'ui',
    exposeHostPort: false,
  });
  if (resolved) {
    const channel = await effectiveChannel('ui');
    await recordCoreProvenance('ui', {
      version: resolved.version,
      tag: resolved.tag,
      branch: channel.branch,
      source: releaseSource.repo_url ?? null,
      artifactSHA256: resolved.artifactSHA256 ?? null,
    });
  }
}

/**
 * Exact bootstrap channels are immutable release identities. A healthy UI
 * container without the matching durable provenance may be the residue of an
 * interrupted older deployment, so it must be replaced from the configured
 * signed artifact instead of being relabelled as current.
 */
async function exactUIProvenanceMatchesConfiguredSource(): Promise<boolean | null> {
  const channel = await effectiveChannel('ui');
  if (!channel.tag && !channel.artifact_sha256) return null;
  if (!channel.tag || !channel.artifact_sha256) {
    throw new Error('Exact UI release requires both a tag and artifact SHA-256');
  }
  const provenance = await getCoreProvenance('ui');
  return (
    provenance?.tag === channel.tag &&
    provenance.branch === channel.branch &&
    provenance.artifact_sha256 === channel.artifact_sha256
  );
}

async function deployPointerContainerFromConfiguredSource(replaceExisting = false): Promise<void> {
  const releaseSource = await getReleaseSource();
  const pointerRepoURL = `${releaseSource.base_url.replace(/\/$/, '')}/${releaseSource.organization}/Pointer`;
  const deploy = replaceExisting ? redeployLXDContainer : deployLXDContainer;
  const resolved = await deploy(pointerContainerSpec(), {
    spineSocketPath: '/var/run/youeye/youeye.sock',
    giteaBaseURL: releaseSource.base_url,
    giteaOrg: releaseSource.organization,
    giteaRepo: 'Pointer',
    releaseChannelKey: 'app:pointer',
    exposeHostPort: false,
  });
  await configurePointerService();
  if (resolved) {
    const channel = await effectiveChannel('app:pointer', { appDefaultSource: pointerRepoURL });
    await recordCoreProvenance('app:pointer', {
      version: resolved.version,
      tag: resolved.tag,
      branch: channel.branch,
      source: channel.source,
      artifactSHA256: resolved.artifactSHA256 ?? null,
    });
  }
}

async function ensurePointerApexRoute(): Promise<void> {
  const settings = await settingsService.getRaw();
  if (!settings.domain) throw new Error('YouEye domain is unavailable for the AI API route');
  await ensurePointerInferenceRoutes(settings.domain);
}

type PointerIdentitySettings = {
  domain?: unknown;
  subdomains?: { identity?: unknown } | null;
};

export function hasPointerIdentitySettings(settings: PointerIdentitySettings): boolean {
  return typeof settings.domain === 'string'
    && settings.domain.trim().length > 0
    && typeof settings.subdomains?.identity === 'string'
    && settings.subdomains.identity.trim().length > 0;
}

/**
 * Provision or reconfigure Pointer only after setup has supplied the stable
 * platform issuer. This is shared by first setup and later domain changes so
 * the managed environment can never retain an obsolete issuer.
 */
export async function configurePointerForPlatform(): Promise<'deployed' | 'configured'> {
  const settings = await settingsService.getRaw();
  if (!hasPointerIdentitySettings(settings)) {
    throw new Error('YouEye AI service requires the platform domain and identity subdomain');
  }

  const exists = await containerExists('youeye-pointer');
  const provenance = exists ? await getCoreProvenance('app:pointer') : null;
  if (exists && !provenance) {
    // A pre-fix bootstrap may have created the container, then failed before
    // managed configuration and provenance committed. Recreate only that
    // unproven runtime from the exact signed channel; its database and secrets
    // remain in persistent platform storage.
    await deployPointerContainerFromConfiguredSource(true);
  } else if (exists) {
    await configurePointerService();
  } else {
    await deployPointerContainerFromConfiguredSource();
  }
  if (!(await waitForPointer())) {
    throw new Error('YouEye AI service did not become ready after managed configuration');
  }
  await applyResourcePolicy('youeye-pointer', 'critical');
  await ensurePointerApexRoute();
  return exists && provenance ? 'configured' : 'deployed';
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
    failDeployment(onEvent, 1, 'Failed to load Market system app manifests', err);
  }

  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  emit(onEvent, 1, 'running', 'Deploying PostgreSQL database...');
  try {
    const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
    const manifest = applySystemImage(postgresManifest(pgPassword), systemImages.postgresql);
    await deployOCIContainer(manifest, '');
    await recordSystemContainerManifest('postgresql', systemImages.postgresql);
    await applyResourcePolicy('youeye-postgres', 'critical');
    await reconcilePostgresCredential(pgPassword);

    const healthy = await waitForPostgres(pgPassword);
    if (!healthy) {
      failDeployment(onEvent, 1, 'PostgreSQL health check failed', 'Container deployed but not accepting connections');
    }
    emit(onEvent, 1, 'success', 'PostgreSQL deployed and accepting connections');
  } catch (err) {
    if (err instanceof ReportedDeploymentError) throw err;
    failDeployment(onEvent, 1, 'PostgreSQL deployment failed', err);
  }

  // ─── Step 2: Caddy reverse proxy ─────────────────────────
  emit(onEvent, 2, 'running', 'Deploying Caddy reverse proxy...');
  try {
    const manifest = applySystemImage(caddyManifest(), systemImages.caddy);
    await deployOCIContainer(manifest, hostIP);
    await recordSystemContainerManifest('caddy', systemImages.caddy);
    await applyResourcePolicy('youeye-caddy', 'critical');

    const healthy = await waitForCaddy();
    if (!healthy) {
      failDeployment(onEvent, 2, 'Caddy health check failed', 'Container deployed but the admin endpoint did not become ready');
    }

    // Use the CP static IP because the Caddy OCI container may resolve the
    // per-app bridge dnsmasq first and miss system-container names.
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
    const reload = await execShell('youeye-caddy',
      `echo '${b64}' | base64 -d > /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
      { timeout: 15000 },
    );
    if (reload.exitCode !== 0) {
      throw new Error(`Caddy configuration reload failed (exit ${reload.exitCode}): ${reload.stderr}`);
    }

    await setDefaultRoute('youeye-control', 3000);
    await ensurePingRoute('youeye-control', 3000);
    await ensureHeaderStrippingRoute();
    emit(onEvent, 2, 'success', 'Caddy deployed and required routes verified');
  } catch (err) {
    if (err instanceof ReportedDeploymentError) throw err;
    failDeployment(onEvent, 2, 'Caddy deployment failed', err);
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
    if (!healthy) {
      failDeployment(onEvent, 3, 'Pi-Hole health check failed', 'Container deployed but DNS did not become ready');
    }
    // Use a one-shot exec environment so the password is not embedded in the
    // command, service environment, progress event, or durable job state.
    await setPiholePasswordViaExec(webPassword);
    emit(onEvent, 3, 'success', 'Pi-Hole deployed and responding');
  } catch (err) {
    if (err instanceof ReportedDeploymentError) throw err;
    failDeployment(onEvent, 3, 'Pi-Hole deployment failed', err);
  }

  // ─── Step 4: YouEye UI ───────────────────────────────────
  emit(onEvent, 4, 'running', 'Deploying YouEye UI container...');
  try {
    let provenanceRepaired = false;
    if ((await exactUIProvenanceMatchesConfiguredSource()) === false) {
      emit(onEvent, 4, 'running', 'Replacing YouEye UI to restore exact signed provenance...');
      await deployUIContainerFromConfiguredSource(true);
      provenanceRepaired = true;
    }
    const result = await repairThenVerify(
      'YouEye UI',
      (stage) => waitForYouEyeUI('youeye-ui', stage === 'initial' ? 10_000 : 120_000),
      () => deployUIContainerFromConfiguredSource(true),
    );
    await applyResourcePolicy('youeye-ui', 'critical');
    await repairUIEgressAcl();
    emit(onEvent, 4, 'success', result === 'repaired' || provenanceRepaired
      ? 'YouEye UI container repaired, health-checked, and egress ACL verified'
      : 'YouEye UI service health and egress ACL verified');
  } catch (err) {
    failDeployment(onEvent, 4, 'UI container deployment failed', err);
  }

  // ─── Step 5: Pointer AI service ──────────────────────────
  emit(onEvent, 5, 'running', 'Deploying YouEye AI service...');
  try {
    const settings = await settingsService.getRaw();
    if (!hasPointerIdentitySettings(settings)) {
      emit(onEvent, 5, 'success', 'YouEye AI service deferred until setup configures the platform domain');
      return;
    }
    const result = await repairThenVerify(
      'YouEye AI service',
      (stage) => waitForPointer(stage === 'initial' ? 10_000 : 120_000),
      () => deployPointerContainerFromConfiguredSource(true),
    );
    await applyResourcePolicy('youeye-pointer', 'critical');
    await ensurePointerApexRoute();
    emit(onEvent, 5, 'success', result === 'repaired'
      ? 'YouEye AI service repaired, migrated, health-checked, and routed at the apex'
      : 'YouEye AI service health and apex API route verified');
  } catch (err) {
    failDeployment(onEvent, 5, 'AI service deployment failed', err);
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
  const RECONCILE_STEPS = 6; // security posture, postgres, caddy, pihole, ui, pointer

  function remit(step: number, status: DeploymentEvent['status'], message: string, detail?: string) {
    onEvent({
      step,
      totalSteps: RECONCILE_STEPS,
      status,
      message,
      detail: detail ? sanitizeDeploymentDetail(detail) : undefined,
    });
  }

  function failReconcile(step: number, message: string, detail?: unknown): never {
    const safeDetail = detail === undefined ? undefined : sanitizeDeploymentDetail(detail);
    remit(step, 'error', message, safeDetail);
    throw new ReportedDeploymentError(safeDetail || message);
  }

  // Check which containers are missing
  const containers = [
    'youeye-postgres',
    'youeye-caddy',
    'youeye-pihole',
    'youeye-ui',
    'youeye-pointer',
  ];

  const missing: string[] = [];
  for (const name of containers) {
    if (!(await containerExists(name))) {
      missing.push(name);
    }
  }

  remit(1, 'running', 'Repairing system security posture...');
  try {
    await repairControlPanelProxy();
    if (missing.includes('youeye-ui')) {
      remit(1, 'success', 'Control Panel proxy repaired; UI ACL will be applied after UI redeploy');
    } else {
      await repairUIEgressAcl();
      remit(1, 'success', 'System security posture repaired and verified');
    }
  } catch (err) {
    failReconcile(1, 'System security posture repair failed', err);
  }

  if (missing.length > 0) console.log(`[reconcile] Missing containers: ${missing.join(', ')}`);

  type SystemImages = Awaited<ReturnType<typeof resolveSystemImageOverrides>>;
  let systemImages: SystemImages | undefined;
  async function requireSystemImages(step: number): Promise<SystemImages> {
    if (systemImages) return systemImages;
    try {
      systemImages = await resolveSystemImageOverrides();
      return systemImages;
    } catch (err) {
      return failReconcile(step, 'Failed to load Market system app manifests', err);
    }
  }

  // ─── Step 1: PostgreSQL ─────────────────────────────────────
  if (missing.includes('youeye-postgres')) {
    remit(2, 'running', 'Deploying missing PostgreSQL database...');
    try {
      const images = await requireSystemImages(2);
      const pgPassword = await getOrCreateSecret('postgres', '.pg_password', () => generatePassword(32));
      const manifest = applySystemImage(postgresManifest(pgPassword), images.postgresql);
      await deployOCIContainer(manifest, '');
      await recordSystemContainerManifest('postgresql', images.postgresql);
      await applyResourcePolicy('youeye-postgres', 'critical');
      await reconcilePostgresCredential(pgPassword);
      const healthy = await waitForPostgres(pgPassword);
      if (!healthy) {
        failReconcile(2, 'PostgreSQL health check failed', 'Container deployed but not accepting connections');
      }
      remit(2, 'success', 'PostgreSQL deployed and accepting connections');
    } catch (err) {
      if (err instanceof ReportedDeploymentError) throw err;
      failReconcile(2, 'PostgreSQL deployment failed', err);
    }
  } else {
    remit(2, 'running', 'Verifying credentialed PostgreSQL health...');
    try {
      const pgPassword = await readSecret('postgres', '.pg_password');
      if (!pgPassword) throw new Error('Persisted PostgreSQL credential is missing; refusing unauthenticated health success');
      const result = await repairThenVerify(
        'PostgreSQL',
        (stage) => waitForPostgres(pgPassword, 'youeye-postgres', stage === 'initial' ? 10_000 : 60_000),
        async () => {
          const images = await requireSystemImages(2);
          const manifest = applySystemImage(postgresManifest(pgPassword), images.postgresql);
          remit(2, 'running', 'PostgreSQL exists but is unhealthy; recreating its container around persistent data...');
          await deployOCIContainer(manifest, '');
          await recordSystemContainerManifest('postgresql', images.postgresql);
          await applyResourcePolicy('youeye-postgres', 'critical');
          await reconcilePostgresCredential(pgPassword);
        },
      );
      remit(2, 'success', result === 'repaired'
        ? 'PostgreSQL container repaired and authenticated query verified'
        : 'PostgreSQL authenticated query verified');
    } catch (err) {
      failReconcile(2, 'PostgreSQL reconciliation failed', err);
    }
  }

  // ─── Step 2: Caddy reverse proxy ─────────────────────────
  if (missing.includes('youeye-caddy')) {
    remit(3, 'running', 'Deploying missing Caddy reverse proxy...');
    try {
      const images = await requireSystemImages(3);
      const manifest = applySystemImage(caddyManifest(), images.caddy);
      await deployOCIContainer(manifest, hostIP);
      await recordSystemContainerManifest('caddy', images.caddy);
      await applyResourcePolicy('youeye-caddy', 'critical');
      const healthy = await waitForCaddy();
      if (!healthy) {
        failReconcile(3, 'Caddy health check failed', 'Container deployed but the admin endpoint did not become ready');
      }

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
      const reload = await execShell('youeye-caddy',
        `echo '${b64}' | base64 -d > /etc/caddy/Caddyfile && caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`,
        { timeout: 15000 },
      );
      if (reload.exitCode !== 0) {
        throw new Error(`Caddy configuration reload failed (exit ${reload.exitCode}): ${reload.stderr}`);
      }
      await setDefaultRoute('youeye-control', 3000);
      await ensurePingRoute('youeye-control', 3000);
      await ensureHeaderStrippingRoute();
      remit(3, 'success', 'Caddy deployed and configured');
    } catch (err) {
      if (err instanceof ReportedDeploymentError) throw err;
      failReconcile(3, 'Caddy deployment failed', err);
    }
  } else {
    try {
      await ensurePingRoute('youeye-control', 3000);
      await ensureHeaderStrippingRoute();
      remit(3, 'skipped', 'Caddy already running and required routes are verified');
    } catch (err) {
      failReconcile(3, 'Caddy is running but required routes could not be verified', err);
    }
  }

  // ─── Step 3: Pi-Hole DNS ─────────────────────────────────
  if (missing.includes('youeye-pihole')) {
    remit(4, 'running', 'Deploying missing Pi-Hole DNS...');
    try {
      const images = await requireSystemImages(4);
      const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
      const manifest = applySystemImage(piholeManifest(hostIP), images.pihole);
      await deployOCIContainer(manifest, hostIP);
      await recordSystemContainerManifest('pihole', images.pihole);
      await applyResourcePolicy('youeye-pihole', 'critical');
      const healthy = await waitForPiHole();
      if (!healthy) {
        failReconcile(4, 'Pi-Hole health check failed', 'Container deployed but DNS did not become ready');
      }
      await setPiholePasswordViaExec(webPassword);
      remit(4, 'success', 'Pi-Hole deployed and responding');
    } catch (err) {
      if (err instanceof ReportedDeploymentError) throw err;
      failReconcile(4, 'Pi-Hole deployment failed', err);
    }
  } else {
    remit(4, 'running', 'Verifying Pi-Hole web and DNS health...');
    try {
      const webPassword = await getOrCreateSecret('pihole', '.web_password', () => generatePassword(24));
      const result = await repairThenVerify(
        'Pi-Hole',
        (stage) => waitForPiHole('youeye-pihole', stage === 'initial' ? 10_000 : 180_000),
        async () => {
          const images = await requireSystemImages(4);
          const manifest = applySystemImage(piholeManifest(hostIP), images.pihole);
          remit(4, 'running', 'Pi-Hole exists but DNS is unhealthy; recreating its container around persistent data...');
          await deployOCIContainer(manifest, hostIP);
          await recordSystemContainerManifest('pihole', images.pihole);
          await applyResourcePolicy('youeye-pihole', 'critical');
        },
      );
      await setPiholePasswordViaExec(webPassword);
      remit(4, 'success', result === 'repaired'
        ? 'Pi-Hole container repaired and DNS query verified'
        : 'Pi-Hole web and DNS health verified');
    } catch (err) {
      failReconcile(4, 'Pi-Hole reconciliation failed', err);
    }
  }

  // ─── Step 4: YouEye UI ───────────────────────────────────
  if (missing.includes('youeye-ui')) {
    remit(5, 'running', 'Deploying missing YouEye UI container...');
    try {
      await deployUIContainerFromConfiguredSource();
      if (!(await waitForYouEyeUI())) {
        failReconcile(5, 'UI container health check failed', 'Container deployed but the UI service did not become ready');
      }
      await applyResourcePolicy('youeye-ui', 'critical');
      await repairUIEgressAcl();
      remit(5, 'success', 'YouEye UI container deployed and egress ACL applied');
    } catch (err) {
      failReconcile(5, 'UI container deployment failed', err);
    }
  } else {
    remit(5, 'running', 'Verifying YouEye UI service and HTTP health...');
    try {
      let provenanceRepaired = false;
      if ((await exactUIProvenanceMatchesConfiguredSource()) === false) {
        remit(5, 'running', 'YouEye UI provenance does not match the exact signed bundle; recreating the deployment container...');
        await deployUIContainerFromConfiguredSource(true);
        provenanceRepaired = true;
      }
      const result = await repairThenVerify(
        'YouEye UI',
        (stage) => waitForYouEyeUI('youeye-ui', stage === 'initial' ? 10_000 : 120_000),
        async () => {
          remit(5, 'running', 'YouEye UI exists but its service is unhealthy; recreating the deployment container...');
          await deployUIContainerFromConfiguredSource(true);
        },
      );
      await applyResourcePolicy('youeye-ui', 'critical');
      await repairUIEgressAcl();
      remit(5, 'success', result === 'repaired' || provenanceRepaired
        ? 'YouEye UI container repaired and HTTP health verified'
        : 'YouEye UI service and HTTP health verified');
    } catch (err) {
      failReconcile(5, 'YouEye UI reconciliation failed', err);
    }
  }

  // ─── Step 6: Pointer AI service ──────────────────────────
  const pointerSettings = await settingsService.getRaw();
  if (!hasPointerIdentitySettings(pointerSettings)) {
    try {
      if (!missing.includes('youeye-pointer')) {
        await deferPointerServiceUntilSetup();
      }
      remit(6, 'success', 'YouEye AI service deferred until setup configures the platform domain');
      return;
    } catch (err) {
      failReconcile(6, 'AI service setup deferral failed', err);
    }
  }

  if (missing.includes('youeye-pointer')) {
    remit(6, 'running', 'Deploying missing YouEye AI service...');
    try {
      await deployPointerContainerFromConfiguredSource();
      if (!(await waitForPointer())) {
        failReconcile(6, 'AI service health check failed', 'Container deployed but Pointer did not become ready');
      }
      await applyResourcePolicy('youeye-pointer', 'critical');
      await ensurePointerApexRoute();
      remit(6, 'success', 'YouEye AI service deployed, migrated, and routed at the apex');
    } catch (err) {
      failReconcile(6, 'AI service deployment failed', err);
    }
  } else {
    remit(6, 'running', 'Verifying YouEye AI service health...');
    try {
      const result = await repairThenVerify(
        'YouEye AI service',
        (stage) => waitForPointer(stage === 'initial' ? 10_000 : 120_000),
        async () => {
          remit(6, 'running', 'YouEye AI service is unhealthy; recreating its deployment container...');
          await deployPointerContainerFromConfiguredSource(true);
        },
      );
      await applyResourcePolicy('youeye-pointer', 'critical');
      await ensurePointerApexRoute();
      remit(6, 'success', result === 'repaired'
        ? 'YouEye AI service repaired, migrated, and health-checked'
        : 'YouEye AI service health and apex API route verified');
    } catch (err) {
      failReconcile(6, 'AI service reconciliation failed', err);
    }
  }

}
