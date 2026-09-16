/**
 * Setup Run API
 *
 * POST /api/setup/run — Execute the full initial setup flow.
 * Streams progress via Server-Sent Events.
 *
 * HARDENED (BUG-011):
 * - Every step is idempotent: check-before-create, update-if-misconfigured
 * - Per-step completion persisted in youeye.yaml setup_steps block
 * - Pi-Hole DNS has 3-retry parity with Caddy
 * - Failed steps produce visible errors, not silent skips
 * - Partial setup resumes from where it left off
 */

import { NextRequest } from 'next/server';
import { getSession, verifyCSRFToken } from '@/lib/auth';
import { settingsService } from '@/lib/settings';
import { spineClient } from '@/lib/spine/client';
import { getContainerIP } from '@/lib/incus/container-ip';
import * as caddy from '@/lib/caddy/client';
import { setDomainDNS } from '@/lib/apps/pihole-api';
import { getIdentityConfig } from '@/lib/identity/config';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
} from '@/lib/identity/core-clients';
import {
  acquireSetupOperation,
  heartbeatSetupOperation,
  markApplianceSetupComplete,
  releaseSetupOperation,
} from '@/lib/identity/store';
import { tlsStorage } from '@/lib/acme/storage';
import {
  claimName,
  getCertificateTerms,
  getCurrentCertificate,
  getLease,
  heartbeat,
  NamesBrokerError,
  namesErrorMessage,
  requestCertificate,
  updateIp,
} from '@/lib/youeye-names/client';
import { generateCsr } from '@/lib/youeye-names/csr';
import { getStagedBundle, consumeStagedBundle, applyBundleIdentity, bundleCertStillValid } from '@/lib/youeye-names/bundle';
import {
  sameCertificateInstant,
  validateCertificateMaterial,
} from '@/lib/youeye-names/certificate';
import { validateStoredIdentity } from '@/lib/youeye-names/identity';
import { readNamesLifecycleState, updateNamesLifecycleState, writeNamesLifecycleState } from '@/lib/youeye-names/state';
import { discoverNamesService, namesServiceBinding, validateManagedName } from '@/lib/youeye-names/service';
import {
  byoDomainBundleCertStillValid,
  bundleToProviderConfig,
  consumeStagedByoDomainBundle,
  getStagedByoDomainBundle,
} from '@/lib/byo-domain/bundle';
import { issueCertificateWithDnsProvider } from '@/lib/acme/client';
import { CloudflareDnsProvider } from '@/lib/dns-providers/cloudflare';
import { createConnectionId, saveByoDnsProviderConfig } from '@/lib/dns-providers/config';
import { managedAddressNames, normalizeDomainInput } from '@/lib/dns-providers/domain';
import { writeProviderToken } from '@/lib/dns-providers/secrets';
import { syncByoDomainDns } from '@/lib/dns-providers/sync';
import { validateDnsProvider } from '@/lib/dns-providers/validation';
import type { ByoDnsProviderConfig } from '@/lib/dns-providers/types';
import { configurePointerForPlatform } from '@/lib/infrastructure/deployer';

/** True for the private/VPN IPv4 ranges YouEye Names accepts. */
function isPrivateIPv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some((n) => n > 255)) return false;
  const [a, b] = o;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

interface SetupRequest {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  site_name_style?: Record<string, unknown>;
  icon_config?: Record<string, unknown>;
  identity_name?: string;
  /** TLS mode chosen during setup (youeye-names, letsencrypt, selfsigned, upload) */
  tls_choice?: string;
  /** YouEye Names leased subdomain (when tls_choice === 'youeye-names') */
  yen_name?: string;
  /** BYO DNS provider connection submitted during setup. */
  byo_dns_provider?: {
    provider?: string;
    token?: string;
  };
  /** Exact broker terms accepted before a first certificate request. */
  yen_terms_version?: string;
  /** Explicit acknowledgement that the public name appears in CT logs. */
  yen_ct_accepted?: boolean;
  /** One-use, memory-only proof bound to the exact selected name and server IP. */
  yen_human_verification_proof?: string;
  /** If set, only run this specific step (retry mode) */
  retry_step?: string;
}

type StepState = 'pending' | 'done' | 'error';

interface SetupSteps {
  config?: StepState;
  caddy?: StepState;
  dns?: StepState;
  ai?: StepState;
  sso_control?: StepState;
  sso_ui?: StepState;
  finalize?: StepState;
}

/** Retry a function up to maxAttempts with delays */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  delays: number[],
  label: string
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      console.error(`${label} attempt ${attempt + 1}/${maxAttempts} failed:`, err);
      if (attempt >= maxAttempts - 1) {
        throw err;
      }
      // NOTE: do NOT gate on `delays[attempt]` truthiness — a `0` delay is
      // legitimate (run the next attempt immediately) and the previous
      // `&& delays[attempt]` check turned `0` into a silent early-throw,
      // making this function only ever run a single attempt for any
      // delay-array starting with 0. Use `?? 0` so an explicit 0 sleeps 0ms
      // and a missing entry also defaults to 0.
      await new Promise(r => setTimeout(r, delays[attempt] ?? 0));
    }
  }
  throw new Error(`${label} failed after ${maxAttempts} attempts`);
}

/** Check if a service is reachable before starting its step */
async function checkConnectivity(name: string, url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) });
    return true;
  } catch {
    return false;
  }
}

/** Read persisted setup step state from youeye.yaml */
async function getSetupSteps(): Promise<SetupSteps> {
  try {
    const raw = await spineClient.getConfig();
    return (raw as Record<string, unknown>).setup_steps as SetupSteps || {};
  } catch {
    return {};
  }
}

/** Persist step completion to youeye.yaml */
async function saveStepState(stepId: string, state: StepState): Promise<void> {
  const current = await getSetupSteps();
  const updated = { ...current, [stepId]: state };
  await spineClient.patchConfig({ setup_steps: updated });
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (
    !session?.isAdmin
    || session.authMethod !== 'setup'
    || !session.setupOwnerId
    || !session.setupSessionId
  ) {
    return new Response('Unauthorized', { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  const body: SetupRequest = await request.json();
  // Sanitize domain: strip trailing dots (e.g. "potemk." → "potemk")
  // Trailing dots produce invalid service URLs like "https://control.potemk."
  if (body.domain) {
    body.domain = body.domain.replace(/\.+$/, '');
  }
  const retryStep = body.retry_step;
  const leaseOwnerId = session.setupOwnerId;
  const leaseSessionId = session.setupSessionId;
  if (!(await acquireSetupOperation(leaseOwnerId, leaseSessionId))) {
    return new Response('Another browser is currently applying setup changes. Wait for it to finish, then reload.', { status: 409 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      function stepUpdate(step: string, status: string, message?: string) {
        send({ step, status, message });
      }

      // Load persisted step state to know what's already done
      const completedSteps = await getSetupSteps();

      /** Check if a step should run: either it's not done, or we're retrying it */
      function shouldRunStep(stepId: string): boolean {
        if (retryStep) return retryStep === stepId;
        return completedSteps[stepId as keyof SetupSteps] !== 'done';
      }

      // Send connectivity status for each service
      try {
        const phIp = await getContainerIP('youeye-pihole');
        const caddyIp = await getContainerIP('youeye-caddy');
        const [phOk, caddyOk, spineOk] = await Promise.all([
          phIp ? checkConnectivity('Pi-Hole', `http://${phIp}:80/api/info/version`) : Promise.resolve(false),
          caddyIp ? checkConnectivity('Caddy', `http://${caddyIp}:2019/config/`) : Promise.resolve(false),
          spineClient.isAvailable(),
        ]);
        send({
          connectivity: {
            pihole: phOk,
            caddy: caddyOk,
            spine: spineOk,
          },
        });
      } catch {
        // Connectivity check is supplementary
      }

      let hasError = false;

      try {
        // ── Step 1: Save config ──────────────────────────────────────
        if (shouldRunStep('config')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('config', 'running');
          const identityName = body.identity_name || `${body.site_name || 'YouEye'} ID`;
          await settingsService.setRaw({
            site_name: body.site_name || 'YouEye',
            domain: body.domain,
            subdomains: body.subdomains,
            identity: { provider: 'youeye-id', name: identityName },
            tls_choice: body.tls_choice || 'selfsigned',
            setup_completed: false,
          });
          await saveStepState('config', 'done');
          stepUpdate('config', 'done', 'Configuration saved');
        } else {
          stepUpdate('config', 'done', 'Already completed');
        }

        // ── Step 2: Caddy reverse proxy ──────────────────────────────
        if (shouldRunStep('caddy')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('caddy', 'running');
          const domain = body.domain;
          const subs = body.subdomains || {};

          // Caddy setDomain — 3 retries
          try {
            await withRetry(
              () => caddy.setDomain(domain),
              3, [0, 2000, 5000],
              'Caddy setDomain'
            );
          } catch {
            stepUpdate('caddy', 'error', 'Could not configure domain TLS — HTTPS may not work');
            await saveStepState('caddy', 'error');
            hasError = true;
          }

          // If a cert was already issued/stored during setup (LE flow in step 0,
          // or a prior YouEye Names run), restore it — setDomain() resets TLS
          // policies to self-signed.
          if (!hasError) {
            try {
              const storedCert = await tlsStorage.getCert();
              if (storedCert && (storedCert.mode === 'acme' || storedCert.mode === 'manual')) {
                await caddy.loadExternalCert(storedCert.certPem, storedCert.keyPem, storedCert.domains);
                console.log(`[setup] Restored ${storedCert.mode} certificate after setDomain`);
              }
            } catch (certErr) {
              console.warn('[setup] Non-fatal: could not restore stored cert:', certErr);
            }
          }

          // ── BYO DNS provider: sync records + install a real certificate ──
          if (!hasError && body.tls_choice === 'byo-provider') {
            const normalizedDomain = normalizeDomainInput(domain);
            const alreadyDone = (await tlsStorage.getCert())?.domains?.includes(normalizedDomain);
            if (!alreadyDone) {
              try {
                const staged = await getStagedByoDomainBundle();
                if (staged && staged.domain !== normalizedDomain) {
                  throw new Error(`The staged domain bundle is for ${staged.domain}, but setup is configuring ${normalizedDomain}. Import a matching bundle or remove the staged bundle.`);
                }

                const provider =
                  body.byo_dns_provider?.provider === 'cloudflare'
                    ? 'cloudflare'
                    : staged?.provider.id === 'cloudflare'
                      ? 'cloudflare'
                      : null;
                const token = (body.byo_dns_provider?.token || staged?.dnsToken.value || '').trim();
                if (!provider) throw new Error('Choose a supported DNS provider.');
                if (!token.trim()) throw new Error('DNS provider token is required.');

                const hostIP = process.env.HOST_IP || '';
                if (!isPrivateIPv4(hostIP)) {
                  throw new Error("Could not determine this server's private network IP. Check HOST_IP and try again.");
                }

                stepUpdate('caddy', 'running', 'Connecting your DNS provider…');
                const validation = await validateDnsProvider({ provider, domain, token, writeTest: true });
                if (!validation.ok || !validation.zone) {
                  throw new Error(validation.error || 'DNS provider validation failed.');
                }

                const connectionId = createConnectionId();
                await writeProviderToken(connectionId, token);
                const plannedRecords = managedAddressNames(validation.domain).map((name) => ({
                  type: 'A' as const,
                  name,
                  content: hostIP,
                }));
                const config: ByoDnsProviderConfig = staged
                  ? {
                      ...bundleToProviderConfig(staged, connectionId, hostIP),
                      provider,
                      domain: validation.domain,
                      zoneId: validation.zone.id,
                      zoneName: validation.zone.name,
                      managedRecords: plannedRecords,
                    }
                  : {
                      mode: 'byo-provider',
                      provider,
                      connectionId,
                      domain: validation.domain,
                      zoneId: validation.zone.id,
                      zoneName: validation.zone.name,
                      delegated: false,
                      managedRecords: plannedRecords,
                      targetIp: hostIP,
                    };
                await saveByoDnsProviderConfig(config);

                stepUpdate('caddy', 'running', 'Pointing your domain at this server…');
                const sync = await syncByoDomainDns('setup', hostIP);
                if (!sync.ok) throw new Error(sync.error || 'DNS sync failed.');

                if (staged?.acme.accountKeyPem) {
                  await tlsStorage.setAccountKey(staged.acme.accountKeyPem);
                }

                if (staged && byoDomainBundleCertStillValid(staged)) {
                  stepUpdate('caddy', 'running', 'Reusing your domain certificate…');
                  const domains = [validation.domain, `*.${validation.domain}`];
                  await tlsStorage.storeCert({
                    ...staged.tls,
                    mode: 'acme',
                    issuer: staged.tls.issuer || "Let's Encrypt",
                    domains,
                    issuedAt: staged.tls.issuedAt || staged.exportedAt,
                  });
                  await caddy.loadExternalCert(staged.tls.certPem, staged.tls.keyPem, domains);
                  const expiresAt = Date.parse(staged.tls.expiresAt);
                  const nextRenewal = Number.isNaN(expiresAt)
                    ? undefined
                    : new Date(expiresAt - 30 * 24 * 60 * 60 * 1000).toISOString();
                  await saveByoDnsProviderConfig({
                    ...config,
                    targetIp: hostIP,
                    lastDnsSyncAt: new Date().toISOString(),
                    lastCertRenewalAt: staged.tls.issuedAt || staged.exportedAt,
                    nextCertRenewalDueAt: nextRenewal,
                  });
                  await consumeStagedByoDomainBundle();
                  console.log('[setup] Reused provider-backed certificate for', validation.domain);
                } else {
                  stepUpdate('caddy', 'running', 'Requesting a trusted certificate…');
                  const dnsProvider = new CloudflareDnsProvider(token);
                  const cert = await issueCertificateWithDnsProvider(
                    validation.domain,
                    dnsProvider,
                    validation.zone,
                    true,
                  );
                  await caddy.loadExternalCert(cert.certificate, cert.privateKey, cert.domains);
                  const expiresAt = new Date(cert.expiresAt);
                  const nextRenewal = new Date(expiresAt.getTime() - 30 * 24 * 60 * 60 * 1000);
                  await saveByoDnsProviderConfig({
                    ...config,
                    targetIp: hostIP,
                    lastDnsSyncAt: new Date().toISOString(),
                    lastCertRenewalAt: new Date().toISOString(),
                    nextCertRenewalDueAt: nextRenewal.toISOString(),
                  });
                  if (staged) await consumeStagedByoDomainBundle();
                  console.log('[setup] Installed provider-backed certificate for', validation.domain);
                }
              } catch (providerErr) {
                stepUpdate('caddy', 'error', providerErr instanceof Error ? providerErr.message : 'DNS provider setup failed');
                await saveStepState('caddy', 'error');
                hasError = true;
              }
            }
          }

          // ── YouEye Names: claim the leased name + install a real certificate ──
          // The broker runs ACME DNS-01 in its discovered managed zone and returns only the
          // chain (the TLS key never leaves this server). Idempotent: if a prior
          // run already stored a cert for this domain it was restored above, so we
          // skip re-issuing.
          if (!hasError && body.tls_choice === 'youeye-names' && body.yen_name) {
            const alreadyDone = (await tlsStorage.getCert())?.domains?.includes(domain);
            if (!alreadyDone) {
              try {
                // The browser is not a trusted source of server addressing.
                // Spine reports the appliance's selected primary LAN/VPN IP.
                const ip = (await spineClient.getMetrics()).primary_ip.trim();
                if (!isPrivateIPv4(ip)) {
                  throw new Error('Could not determine this server’s private network address. Check its network connection and try again.');
                }
                const staged = await getStagedBundle();
                if (staged && (staged.name !== body.yen_name || staged.fqdn !== domain)) {
                  throw new Error(`The saved name is for ${staged.fqdn}, but setup selected ${domain}.`);
                }
                const domains = [domain, `*.${domain}`];
                const importedIdentity = staged
                  ? validateStoredIdentity(staged.identity).identity
                  : undefined;

                if (staged && bundleCertStillValid(staged)) {
                  // ── Reuse: install the bundled cert, NO Let's Encrypt issuance ──
                  stepUpdate('caddy', 'running', 'Reusing your YouEye Names certificate…');
                  await caddy.loadExternalCert(staged.tls.certPem, staged.tls.keyPem, domains);
                  await tlsStorage.storeCert({
                    mode: 'manual', certPem: staged.tls.certPem, keyPem: staged.tls.keyPem,
                    issuer: 'YouEye Names', domains,
                    expiresAt: staged.certificate.expiresAt,
                    issuedAt: staged.certificate.issuedAt,
                  });
                  // Resume the lease + repoint DNS at this box's current IP (DNS-only).
                  try {
                    await claimName(staged.name, ip, importedIdentity);
                  } catch (claimErr) {
                    if (
                      !(claimErr instanceof NamesBrokerError) ||
                      claimErr.code !== 'install_already_has_active_lease'
                    ) {
                      throw claimErr;
                    }
                    await getLease(staged.name, importedIdentity);
                  }
                  await updateIp(staged.name, ip, importedIdentity);
                  await applyBundleIdentity(staged);
                  const activatedAt = new Date().toISOString();
                  await writeNamesLifecycleState({
                    schemaVersion: 2,
                    service: staged.service,
                    name: staged.name,
                    fqdn: domain,
                    status: 'healthy',
                    provisioning: null,
                    termsVersion: staged.consent.termsVersion,
                    certificateTransparencyAcceptedAt: staged.consent.certificateTransparencyAcceptedAt,
                    certificate: {
                      fingerprint: staged.certificate.fingerprint,
                      provider: staged.certificate.provider,
                      issuedAt: staged.certificate.issuedAt,
                      expiresAt: staged.certificate.expiresAt,
                    },
                    lastBrokerContactAt: activatedAt,
                    lastHeartbeatAt: null,
                    nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
                    lastError: null,
                  });
                  await consumeStagedBundle();
                  try {
                    await heartbeat(staged.name, {
                      currentIp: ip,
                      certificateFingerprint: validateCertificateMaterial({
                        certificateChain: staged.tls.certPem,
                        privateKeyPem: staged.tls.keyPem,
                        fqdn: domain,
                      }).brokerFingerprint,
                      certificateExpiresAt: staged.certificate.expiresAt,
                      caddyStatus: 'healthy',
                    }, importedIdentity);
                    await updateNamesLifecycleState((state) => ({ ...state, lastHeartbeatAt: new Date().toISOString() }));
                  } catch (heartbeatError) {
                    console.warn('[setup] Initial YouEye Names heartbeat will retry automatically:', heartbeatError instanceof Error ? heartbeatError.message : 'unknown error');
                  }
                  console.log('[setup] Reused YouEye Names certificate for', domain);
                } else {
                  // ── Fresh issuance (or expired bundle → re-issue under same name) ──
                  stepUpdate('caddy', 'running', 'Securing your YouEye Names address…');
                  const terms = await getCertificateTerms();
                  const service = await discoverNamesService();
                  validateManagedName(service, body.yen_name, domain, `*.${domain}`);
                  if (
                    body.yen_ct_accepted !== true ||
                    !body.yen_terms_version ||
                    body.yen_terms_version !== terms.version
                  ) {
                    throw new Error('Review and accept the current YouEye Names certificate notice before continuing.');
                  }
                  if (
                    typeof body.yen_human_verification_proof !== 'string' ||
                    body.yen_human_verification_proof.length < 20 ||
                    body.yen_human_verification_proof.length > 512
                  ) {
                    throw new Error('Complete the final YouEye Names verification before starting setup.');
                  }
                  // Claim (tolerate a lease we already own from a prior attempt).
                  try {
                    await claimName(
                      body.yen_name,
                      ip,
                      importedIdentity,
                      body.yen_human_verification_proof,
                    );
                  } catch (claimErr) {
                    if (
                      !(claimErr instanceof NamesBrokerError) ||
                      claimErr.code !== 'install_already_has_active_lease'
                    ) {
                      throw claimErr;
                    }
                    await getLease(body.yen_name, importedIdentity);
                  }
                  const priorProvisioning = await readNamesLifecycleState().catch(() => null);
                  const canResume = priorProvisioning?.status === 'provisioning' &&
                    priorProvisioning.name === body.yen_name && priorProvisioning.fqdn === domain &&
                    priorProvisioning.service.id === service.id &&
                    priorProvisioning.service.canonicalOrigin === service.canonicalOrigin &&
                    !!priorProvisioning.provisioning?.privateKeyPem && !!priorProvisioning.provisioning.csrPem;
                  const provisioningStartedAt = canResume
                    ? priorProvisioning.provisioning!.startedAt
                    : new Date().toISOString();
                  const priorPrivateKey = canResume ? priorProvisioning.provisioning!.privateKeyPem : null;
                  const priorCsr = canResume ? priorProvisioning.provisioning!.csrPem : null;
                  await writeNamesLifecycleState({
                    schemaVersion: 2,
                    service: namesServiceBinding(service),
                    name: body.yen_name,
                    fqdn: domain,
                    status: 'provisioning',
                    provisioning: {
                      stage: 'lease_claimed',
                      startedAt: provisioningStartedAt,
                      lastAttemptAt: provisioningStartedAt,
                      brokerRequestId: null,
                      privateKeyPem: priorPrivateKey,
                      csrPem: priorCsr,
                    },
                    termsVersion: terms.version,
                    certificateTransparencyAcceptedAt: provisioningStartedAt,
                    certificate: null,
                    lastBrokerContactAt: provisioningStartedAt,
                    lastHeartbeatAt: null,
                    nextCheckAt: provisioningStartedAt,
                    lastError: null,
                  });
                  const generated = priorPrivateKey && priorCsr
                    ? { keyPem: priorPrivateKey, csrPem: priorCsr }
                    : await generateCsr(domain);
                  const { keyPem, csrPem } = generated;
                  await updateNamesLifecycleState((state) => ({
                    ...state,
                    provisioning: state.provisioning ? {
                      ...state.provisioning,
                      stage: 'certificate_requested',
                      lastAttemptAt: new Date().toISOString(),
                      privateKeyPem: keyPem,
                      csrPem,
                    } : state.provisioning,
                  }));
                  await requestCertificate(
                    body.yen_name,
                    csrPem,
                    terms.version,
                    true,
                    importedIdentity,
                  );
                  await updateNamesLifecycleState((state) => ({
                    ...state,
                    provisioning: state.provisioning ? {
                      ...state.provisioning,
                      stage: 'certificate_waiting',
                      lastAttemptAt: new Date().toISOString(),
                    } : state.provisioning,
                  }));
                  // The authoritative propagation policy can consume six minutes
                  // before CA work starts, so keep the visible wait bounded at ten.
                  let cert: Awaited<ReturnType<typeof getCurrentCertificate>> = null;
                  const deadline = Date.now() + 10 * 60_000;
                  let pollDelay = 2_000;
                  while (Date.now() < deadline) {
                    cert = await getCurrentCertificate(body.yen_name, importedIdentity);
                    if (cert) break;
                    await new Promise((resolve) => setTimeout(resolve, pollDelay));
                    pollDelay = Math.min(8_000, Math.round(pollDelay * 1.5));
                  }
                  if (!cert) {
                    throw new Error('Your YouEye Names certificate is taking longer than usual to issue. It may still arrive shortly — you can retry this step.');
                  }
                  await updateNamesLifecycleState((state) => ({
                    ...state,
                    provisioning: state.provisioning ? {
                      ...state.provisioning,
                      stage: 'certificate_received',
                      lastAttemptAt: new Date().toISOString(),
                    } : state.provisioning,
                  }));
                  const validatedCertificate = validateCertificateMaterial({
                    certificateChain: cert.certificateChain,
                    privateKeyPem: keyPem,
                    fqdn: domain,
                  });
                  if (
                    validatedCertificate.brokerFingerprint !== cert.fingerprint ||
                    !sameCertificateInstant(validatedCertificate.expiresAt, cert.expiresAt)
                  ) {
                    throw new Error('YouEye Names returned inconsistent certificate metadata. Nothing was installed.');
                  }
                  await caddy.loadExternalCert(validatedCertificate.certificateChain, keyPem, domains);
                  await updateNamesLifecycleState((state) => ({
                    ...state,
                    provisioning: state.provisioning ? {
                      ...state.provisioning,
                      stage: 'activating',
                      lastAttemptAt: new Date().toISOString(),
                    } : state.provisioning,
                  }));
                  await tlsStorage.storeCert({
                    mode: 'manual', certPem: validatedCertificate.certificateChain, keyPem,
                    issuer: 'YouEye Names', domains,
                    expiresAt: validatedCertificate.expiresAt,
                    issuedAt: validatedCertificate.issuedAt,
                  });
                  if (staged) {
                    await applyBundleIdentity(staged);
                    await consumeStagedBundle();
                  }
                  const activatedAt = new Date().toISOString();
                  await writeNamesLifecycleState({
                    schemaVersion: 2,
                    service: namesServiceBinding(service),
                    name: body.yen_name,
                    fqdn: domain,
                    status: 'healthy',
                    provisioning: null,
                    termsVersion: terms.version,
                    certificateTransparencyAcceptedAt: activatedAt,
                    certificate: {
                      fingerprint: validatedCertificate.fingerprint,
                      provider: cert.provider,
                      issuedAt: validatedCertificate.issuedAt,
                      expiresAt: validatedCertificate.expiresAt,
                    },
                    lastBrokerContactAt: activatedAt,
                    lastHeartbeatAt: null,
                    nextCheckAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
                    lastError: null,
                  });
                  try {
                    await heartbeat(body.yen_name, {
                      currentIp: ip,
                      certificateFingerprint: validatedCertificate.brokerFingerprint,
                      certificateExpiresAt: validatedCertificate.expiresAt,
                      caddyStatus: 'healthy',
                    }, importedIdentity);
                    await updateNamesLifecycleState((state) => ({ ...state, lastHeartbeatAt: new Date().toISOString() }));
                  } catch (heartbeatError) {
                    console.warn('[setup] Initial YouEye Names heartbeat will retry automatically:', heartbeatError instanceof Error ? heartbeatError.message : 'unknown error');
                  }
                  console.log('[setup] Installed YouEye Names certificate for', domain);
                }
              } catch (yenErr) {
                console.error(
                  '[setup] YouEye Names certificate setup failed:',
                  yenErr instanceof NamesBrokerError
                    ? `${yenErr.code}${yenErr.requestId ? ` (request ${yenErr.requestId})` : ''}`
                    : yenErr instanceof Error
                      ? yenErr.message
                      : 'unknown error',
                );
                stepUpdate(
                  'caddy',
                  'error',
                  yenErr instanceof NamesBrokerError
                    ? namesErrorMessage(yenErr)
                    : yenErr instanceof Error
                      ? yenErr.message
                      : 'YouEye Names certificate failed',
                );
                await saveStepState('caddy', 'error');
                hasError = true;
              }
            }
          }

          if (!hasError || retryStep === 'caddy') {
            if (!subs.identity) {
              throw new Error('Identity provider subdomain is missing. Set subdomains.identity before provisioning.');
            }

            // Route mappings — setContainerRoute is already idempotent (Caddy overwrites existing routes)
            const routeMap: Array<{ sub: string; container: string; port: number }> = [
              { sub: subs.control || 'control', container: 'youeye-control', port: 3000 },
              { sub: subs.dns || 'dns', container: 'youeye-pihole', port: 80 },
            ];

            const uiSub = subs.ui || '';
            if (uiSub) {
              routeMap.push({ sub: uiSub, container: 'youeye-ui', port: 3000 });
            }

            const routeErrors: string[] = [];
            for (const route of routeMap) {
              try {
                const result = await caddy.setContainerRoute(domain, route.container, route.port, 'subdomain', route.sub);
                if (!result.success) {
                  routeErrors.push(`${route.container}: ${result.error}`);
                }
              } catch (err) {
                routeErrors.push(`${route.container}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            try {
              const identity = await getIdentityConfig();
              await caddy.ensureIdentityRoute(`${subs.identity}.${domain}`, identity.containerName, identity.port);
            } catch (err) {
              console.error('Failed to create identity provider route:', err);
              routeErrors.push(`youeye-id: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Root domain UI route
            if (!uiSub) {
              try {
                const result = await caddy.setContainerRoute(domain, 'youeye-ui', 3000, 'subdomain', '');
                if (!result.success) {
                  routeErrors.push(`youeye-ui (root): ${result.error}`);
                }
              } catch (err) {
                console.error('Failed to create root domain UI route:', err);
                routeErrors.push(`youeye-ui (root): ${err instanceof Error ? err.message : String(err)}`);
              }
            }

            // Root domain /settings route to Control Panel. This must be separate from
            // generic path routing because UI and CP both serve Next.js /_next assets.
            try {
              await caddy.ensureControlSettingsRoute(domain, 'youeye-control', 3000);
              await caddy.ensurePointerInferenceRoutes(domain);
            } catch (err) {
              console.error('Failed to create root domain /settings CP route:', err);
              routeErrors.push(`youeye-control (/settings): ${err instanceof Error ? err.message : String(err)}`);
            }

            // Default catch-all
            try {
              await caddy.setDefaultRoute('youeye-control', 3000);
            } catch {
              // Non-critical
            }

            // BUG-022: Ensure /api/ping route exists so Spine health checks work
            // regardless of which domain is used (root domain may route to UI, not CP)
            try {
              await caddy.ensurePingRoute('youeye-control', 3000);
            } catch {
              // Non-critical — Spine can still use IP-based access
            }

            // Security: Strip service-auth headers from all external requests
            try {
              await caddy.ensureHeaderStrippingRoute();
            } catch {
              // Non-critical — internal traffic is unaffected
            }

            try {
              await caddy.migrateSystemUpstreamsToIPv4();
            } catch (err) {
              console.error('Failed to migrate Caddy system upstreams to IPv4:', err);
              routeErrors.push(`caddy-upstream-migration: ${err instanceof Error ? err.message : String(err)}`);
            }

            if (routeErrors.length > 0) {
              stepUpdate('caddy', 'done', `Routes created with ${routeErrors.length} error(s): ${routeErrors.join('; ')}`);
            } else {
              stepUpdate('caddy', 'done', `Routes created for ${routeMap.length + (!uiSub ? 1 : 0)} services`);
            }
            await saveStepState('caddy', 'done');
            hasError = false;
          }
        } else {
          stepUpdate('caddy', 'done', 'Already completed');
        }

        // ── Step 2b: Pi-Hole DNS — with 3-retry parity ──────────────
        if (shouldRunStep('dns')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('dns', 'running');
          const hostIP = process.env.HOST_IP;
          const domain = body.domain;
          if (hostIP && domain) {
            try {
              await withRetry(
                () => setDomainDNS(domain, hostIP),
                3, [0, 2000, 5000],
                'Pi-Hole DNS'
              );
              await saveStepState('dns', 'done');
              stepUpdate('dns', 'done', `DNS rewrite added: *.${domain} → ${hostIP}`);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              await saveStepState('dns', 'error');
              stepUpdate('dns', 'error', `DNS rewrites failed — local subdomain resolution may not work. Check Pi-Hole status and retry. (${msg})`);
              hasError = true;
            }
          } else {
            await saveStepState('dns', 'done');
            stepUpdate('dns', 'done', 'Skipped — HOST_IP not available');
          }
        } else {
          stepUpdate('dns', 'done', 'Already completed');
        }

        // ── Step 3: Managed AI service ───────────────────────────────
        // Pointer's issuer is the setup-selected identity URL. It must not be
        // started during pre-Web bootstrap with a placeholder issuer because
        // that would either crash-loop or retain an invalid trust boundary.
        if (shouldRunStep('ai')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('ai', 'running');
          try {
            const result = await configurePointerForPlatform();
            await saveStepState('ai', 'done');
            stepUpdate('ai', 'done', result === 'deployed'
              ? 'YouEye AI service deployed and connected to YouEye ID'
              : 'YouEye AI service identity configuration refreshed');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await saveStepState('ai', 'error');
            stepUpdate('ai', 'error', `YouEye AI service setup failed: ${msg}`);
            hasError = true;
          }
        } else {
          stepUpdate('ai', 'done', 'Already completed');
        }

        // ── Step 4: SSO for Control Panel (idempotent) ───────────────
        if (shouldRunStep('sso_control')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('sso_control', 'running');
          const domain = body.domain;
          const subs = body.subdomains || {};
          const controlHost = `${subs.control || 'control'}.${domain}`;
          await configureControlPanelIdentitySSO({
            controlExternalUrl: `https://${controlHost}`,
            settingsExternalUrl: `https://${domain}/settings`,
          });
          await saveStepState('sso_control', 'done');
          stepUpdate('sso_control', 'done', 'Identity provider configured for Control Panel');
        } else {
          stepUpdate('sso_control', 'done', 'Already completed');
        }

        // ── Step 5: SSO for UI + enable (idempotent) ─────────────────
        if (shouldRunStep('sso_ui')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('sso_ui', 'running');
          const domain = body.domain;
          const subs = body.subdomains || {};
          const uiSub = subs.ui || '';

          let uiInstalled = false;
          try {
            const status = await spineClient.status();
            uiInstalled = !!status.ui?.installed;
          } catch { /* not installed */ }

          if (uiInstalled) {
            const uiHost = uiSub ? `${uiSub}.${domain}` : domain;

            try {
              const pgCreds = await spineClient.getPostgresCredentials();
              const dbUrl = `postgresql://${pgCreds.user}:${pgCreds.password}@${pgCreds.host}:${pgCreds.port}/youeye_ui`;

              await configureUIIdentitySSO({
                uiExternalUrl: `https://${uiHost}`,
                databaseUrl: dbUrl,
              });

                // Write site_name to UI database (idempotent via ON CONFLICT)
                try {
                  const { execShell } = await import('@/lib/incus/server');
                  const siteName = (body.site_name || 'YouEye').replace(/"/g, '\\"');
                  const sqlCmd = `INSERT INTO system_settings (key, value, updated_at) VALUES ('site_name', '"${siteName}"'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`;
                  const b64 = Buffer.from(sqlCmd).toString('base64');
                  await execShell(
                    'youeye-postgres',
                    `echo "${b64}" | base64 -d | su - postgres -c "psql -U youeye -d youeye_ui"`,
                    { timeout: 10000 }
                  );

                  if (body.site_name_style) {
                    const styleJson = JSON.stringify(body.site_name_style).replace(/'/g, "''");
                    const styleSql = `INSERT INTO system_settings (key, value, updated_at) VALUES ('site_name_style', '${styleJson}'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`;
                    const styleB64 = Buffer.from(styleSql).toString('base64');
                    await execShell(
                      'youeye-postgres',
                      `echo "${styleB64}" | base64 -d | su - postgres -c "psql -U youeye -d youeye_ui"`,
                      { timeout: 10000 }
                    );
                  }

                  // Ensure fontconfig is installed for server-side icon rendering
                  try {
                    await execShell(
                      'youeye-ui',
                      'dpkg -s fontconfig >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -qq fontconfig fonts-dejavu-core)',
                      { timeout: 60000 }
                    );
                    // Register custom fonts directory
                    await execShell(
                      'youeye-ui',
                      'mkdir -p /etc/fonts/conf.d && echo \'<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/opt/youeye-ui/public/fonts</dir></fontconfig>\' > /etc/fonts/conf.d/90-youeye-fonts.conf && fc-cache -f',
                      { timeout: 15000 }
                    );
                  } catch (fontErr) {
                    console.warn('Non-fatal: fontconfig setup failed:', fontErr);
                  }

                  // Write icon_config to UI database
                  if (body.icon_config) {
                    const iconJson = JSON.stringify(body.icon_config).replace(/'/g, "''");
                    const iconSql = `INSERT INTO system_settings (key, value, updated_at) VALUES ('site_icon_config', '${iconJson}'::jsonb, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();`;
                    const iconB64 = Buffer.from(iconSql).toString('base64');
                    await execShell(
                      'youeye-postgres',
                      `echo "${iconB64}" | base64 -d | su - postgres -c "psql -U youeye -d youeye_ui"`,
                      { timeout: 10000 }
                    );
                  }
                } catch (e) {
                  console.error('Failed to write site_name to UI database:', e);
                }

                await saveStepState('sso_ui', 'done');
                stepUpdate('sso_ui', 'done', 'UI enabled and identity provider configured');
            } catch (err) {
              console.error('UI SSO setup failed:', err);
              await saveStepState('sso_ui', 'error');
              stepUpdate('sso_ui', 'error', `UI SSO failed: ${err instanceof Error ? err.message : String(err)}`);
              hasError = true;
            }
          } else {
            await saveStepState('sso_ui', 'done');
            stepUpdate('sso_ui', 'done', 'UI container not installed, skipped');
          }
        } else {
          stepUpdate('sso_ui', 'done', 'Already completed');
        }

        // ── Step 6: Finalize ─────────────────────────────────────────
        if (shouldRunStep('finalize')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('finalize', 'running');
          if (hasError) {
            const message = 'Setup needs attention before finishing. Fix the failed step and try again.';
            await saveStepState('finalize', 'error');
            stepUpdate('finalize', 'error', message);
            send({ error: message, complete: false, hasErrors: true });
            await releaseSetupOperation(leaseOwnerId, leaseSessionId);
            controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          await settingsService.setRaw({
            setup_completed: true,
            tls_choice: body.tls_choice || 'selfsigned',
          });
          // Clear setup_steps on successful completion
          await spineClient.patchConfig({ setup_steps: {} });
          await saveStepState('finalize', 'done');
          stepUpdate('finalize', 'done', 'Setup marked as complete');
        } else {
          stepUpdate('finalize', 'done', 'Already completed');
        }

        await markApplianceSetupComplete(leaseOwnerId, leaseSessionId);
        await spineClient.restartControl(5);

        send({ complete: true, hasErrors: hasError });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('Setup failed:', err);
        await releaseSetupOperation(leaseOwnerId, leaseSessionId).catch(() => {});
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
