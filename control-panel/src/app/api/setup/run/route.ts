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
 * - After config and the Caddy domain, the YouEye Names activation, DNS, AI and
 *   both SSO steps run side by side; finalize waits for all of them
 * - The YouEye Names certificate was started after the human check
 *   (/api/setup/names/start); this route only awaits and activates it
 */

import { NextRequest } from 'next/server';
import { beginSetupRun, withSetupMutation } from '@/lib/setup/lifecycle';
import { assertProvisioningStepsComplete } from '@/lib/setup/readiness';
import { requireSetupSession } from '@/lib/setup/session';
import { settingsService } from '@/lib/settings';
import { spineClient } from '@/lib/spine/client';
import { designSchema } from '@youeye/branding';
import { syncSetupBranding } from '@/lib/ui/setup-branding';
import { getContainerIP } from '@/lib/incus/container-ip';
import * as caddy from '@/lib/caddy/client';
import { withCaddyMutation } from '@/lib/caddy/serial';
import { isReservedSetupDomain, RESERVED_SETUP_DOMAIN_ERROR } from '@/lib/auth/setup-names';
import { recordSetupRouteResult } from '@/lib/caddy/setup-result';
import { setDomainDNS, setIdentityHostDNS } from '@/lib/apps/pihole-api';
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
import { NamesBrokerError, namesErrorMessage, namesLogReason } from '@/lib/youeye-names/client';
import {
  activateNamesCertificate,
  activateStagedNamesBundle,
  awaitNamesCertificate,
} from '@/lib/youeye-names/provision';
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
import { setupStepReason } from '@/lib/setup/step-reason';
import {
  runSetupStepsTogether,
  setupStepStore,
  StepFailure,
  type SetupStepContext,
  type StepState,
} from '@/lib/setup/provisioning-steps';

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
  branding_revision?: string | null;
  icon_config?: Record<string, unknown>;
  identity_name?: string;
  /** TLS mode chosen during setup (youeye-names, letsencrypt, selfsigned, upload) */
  tls_choice?: string;
  /** YouEye Names name claimed by /api/setup/names/start (when tls_choice === 'youeye-names') */
  yen_name?: string;
  /** BYO DNS provider connection submitted during setup. */
  byo_dns_provider?: {
    provider?: string;
    token?: string;
  };
  /** If set, only run this specific step (retry mode) */
  retry_step?: string;
}

interface SetupSteps {
  config?: StepState;
  caddy?: StepState;
  names?: StepState;
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

async function getSetupConfig(): Promise<Record<string, unknown>> {
  try {
    return await spineClient.getConfig() as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Read persisted setup step state from youeye.yaml */
async function getSetupSteps(): Promise<SetupSteps> {
  return (await getSetupConfig()).setup_steps as SetupSteps || {};
}

export async function POST(request: NextRequest) {
  // A setup cookie from before a reset is answered with 401 (claim or sign in
  // again), never with "another browser is applying setup".
  const auth = await requireSetupSession(request);
  if (auth.response) return auth.response;
  const session = auth.session;

  const body: SetupRequest = await request.json();
  if (body.site_name_style?.mytitle !== undefined) {
    const design = designSchema.safeParse(body.site_name_style.mytitle);
    if (!design.success || design.data.name !== body.site_name) return new Response('Invalid title and sticker', { status: 400 });
    if (body.branding_revision !== null && (typeof body.branding_revision !== 'string' || !/^[a-f0-9]{64}$/.test(body.branding_revision))) return new Response('An appearance revision is required', { status: 400 });
    body.site_name_style.mytitle = design.data;
  }
  // Sanitize domain: strip trailing dots (e.g. "potemk." → "potemk")
  // Trailing dots produce invalid service URLs like "https://control.potemk."
  if (body.domain) {
    body.domain = body.domain.replace(/\.+$/, '');
    if (isReservedSetupDomain(body.domain)) return new Response(RESERVED_SETUP_DOMAIN_ERROR, { status: 400 });
  }
  const retryStep = body.retry_step;
  const leaseOwnerId = session.setupOwnerId;
  const leaseSessionId = session.setupSessionId;
  if (!(await acquireSetupOperation(leaseOwnerId, leaseSessionId))) {
    return new Response('Another browser is currently applying setup changes. Wait for it to finish, then reload.', { status: 409 });
  }

  let connected = true;
  const stream = new ReadableStream({
    async start(controller) {
      function send(data: Record<string, unknown>) {
        if (!connected) return;
        try { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`)); }
        catch { connected = false; }
      }
      function finish() {
        if (!connected) return;
        try {
          controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          controller.close();
        } catch { /* A disconnected reader does not cancel retained setup work. */ }
        connected = false;
      }

      function stepUpdate(step: string, status: string, message?: string) {
        send({ step, status, message });
      }

      const endRun = beginSetupRun();
      try {
      await withSetupMutation(leaseOwnerId, 'setup', `setup:${leaseOwnerId}`, async (settle) => {
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
      const steps = setupStepStore({ read: getSetupConfig, patch: (patch) => spineClient.patchConfig(patch) });
      const stepContext: SetupStepContext = {
        store: steps,
        shouldRun: shouldRunStep,
        heartbeat: () => heartbeatSetupOperation(leaseOwnerId, leaseSessionId),
        report: stepUpdate,
        log: (stepId, err) => console.error(`[setup] step ${stepId} failed:`, err instanceof NamesBrokerError ? namesLogReason(err) : err),
      };

      try {
        // ── Step 1: Save config ──────────────────────────────────────
        if (shouldRunStep('config')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('config', 'running');
          await steps.started('config');
          const identityName = body.identity_name || `${body.site_name || 'YouEye'} ID`;
          await settingsService.setRaw({
            site_name: body.site_name || 'YouEye',
            domain: body.domain,
            subdomains: body.subdomains,
            identity: { provider: 'youeye-id', name: identityName },
            tls_choice: body.tls_choice || 'selfsigned',
            setup_completed: false,
          });
          await steps.save('config', 'done');
          stepUpdate('config', 'done', 'Configuration saved');
        } else {
          stepUpdate('config', 'done', 'Already completed');
        }

        // ── Step 2: Caddy domain, BYO certificate and routes ─────────
        // One Caddy writer at a time: the YouEye Names job may load its
        // certificate while this step runs.
        if (shouldRunStep('caddy')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('caddy', 'running');
          await steps.started('caddy');
          hasError = await withCaddyMutation(async () => {
          let hasError = false;
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
            await steps.save('caddy', 'error');
            hasError = true;
          }

          // If a cert was already issued/stored during setup (the YouEye Names
          // job, or a prior run), restore it — setDomain() resets TLS
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
                await steps.save('caddy', 'error');
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
              await caddy.ensureIdentityRoute(new URL(identity.issuer).hostname, identity.containerName, identity.port);
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
            // Pointer's /v1 routes belong to the AI step, so a missing or still
            // starting AI service never fails reverse-proxy setup.
            try {
              await caddy.reconcileManagedRoutes(domain, {}, { pointer: false });
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

            hasError = await recordSetupRouteResult(
              routeErrors,
              `Routes created for ${routeMap.length + (!uiSub ? 1 : 0)} services`,
              (state, message) => stepUpdate('caddy', state, message),
              (state) => steps.save('caddy', state),
            );
          }
          return hasError;
          });
        } else {
          stepUpdate('caddy', 'done', 'Already completed');
        }

        // ── Steps 3–7 side by side; finalize waits for all ───────────
        // None of them needs the public certificate: Pointer trusts Caddy's
        // internal CA and its routes are probed with both CAs, and the SSO
        // steps reach YouEye ID through its internal URL.
        const allDone = await runSetupStepsTogether(stepContext, [
          // YouEye Names: await the job started after the human check (never a
          // new claim or certificate request), then activate its certificate.
          ['names', async () => {
            const name = body.yen_name;
            if (body.tls_choice !== 'youeye-names' || !name) return 'Not used';
            if (await activateStagedNamesBundle(name, body.domain)) return 'Reused your YouEye Names certificate';
            stepUpdate('names', 'running', 'Waiting for your YouEye Names certificate…');
            try {
              await awaitNamesCertificate(name, body.domain);
              await activateNamesCertificate(body.domain);
            } catch (err) {
              if (err instanceof NamesBrokerError) throw new StepFailure(namesErrorMessage(err), namesLogReason(err));
              throw err;
            }
            return 'YouEye Names certificate installed';
          }],

          // Pi-Hole DNS — with 3-retry parity
          ['dns', async () => {
            const hostIP = process.env.HOST_IP;
            const domain = body.domain;
            if (!hostIP || !domain) return 'Skipped — HOST_IP not available';
            try {
              await withRetry(
                async () => {
                  await setDomainDNS(domain, hostIP);
                  const identityHost = new URL((await getIdentityConfig()).issuer).hostname;
                  if (identityHost !== domain && !identityHost.endsWith(`.${domain}`)) {
                    await setIdentityHostDNS(identityHost, hostIP);
                  }
                },
                3, [0, 2000, 5000],
                'Pi-Hole DNS'
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new StepFailure(`DNS rewrites failed — local subdomain resolution may not work. Check Pi-Hole status and retry. (${msg})`, setupStepReason(err));
            }
            return `DNS rewrite added: *.${domain} → ${hostIP}`;
          }],

          // Managed AI service. Pointer's issuer is the setup-selected identity
          // URL, so it is configured only now (it was built at first boot). Its
          // apex inference routes (/v1/*) are added after it is ready; any
          // failure is reported once, by this step.
          ['ai', async () => {
            let stage = 'setup';
            try {
              // Stable issuer settings were saved above; proxy routes precede this.
              const result = await configurePointerForPlatform(undefined, { deferRoutes: true });
              stage = 'API route setup';
              await withCaddyMutation(() => caddy.reconcileManagedRoutes(body.domain, {}, { pointer: true }));
              return result === 'deployed'
                ? 'YouEye AI service deployed and connected to YouEye ID'
                : 'YouEye AI service identity configuration refreshed';
            } catch (err) {
              console.error(`[setup] YouEye AI service ${stage} failed:`, err);
              const reason = setupStepReason(err);
              throw new StepFailure(`YouEye AI service ${stage} failed: ${reason}`, reason);
            }
          }],

          // SSO for Control Panel (idempotent)
          ['sso_control', async () => {
            const subs = body.subdomains || {};
            const controlHost = `${subs.control || 'control'}.${body.domain}`;
            await configureControlPanelIdentitySSO({
              controlExternalUrl: `https://${controlHost}`,
              settingsExternalUrl: `https://${body.domain}/settings`,
            });
            return 'Identity provider configured for Control Panel';
          }],

          // SSO for UI + enable (idempotent)
          ['sso_ui', async () => {
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
                  if (body.site_name_style?.mytitle) {
                    await syncSetupBranding(body.site_name, body.site_name_style, body.branding_revision!);
                  } else {
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
                  }
                } catch (e) {
                  if (body.site_name_style?.mytitle) throw e;
                  console.error('Failed to write site_name to UI database:', e);
                }

                return 'UI enabled and identity provider configured';
            } catch (err) {
              console.error('UI SSO setup failed:', err);
              throw new StepFailure(`UI SSO failed: ${err instanceof Error ? err.message : String(err)}`, setupStepReason(err));
            }
          }
          return 'UI container not installed, skipped';
          }],
        ]);
        if (!allDone) hasError = true;

        // ── Step 8: Finalize ─────────────────────────────────────────
        // A retry of one failed step must not skip this completion gate.
        if (hasError) {
          const message = 'Setup needs attention before finishing. Fix the failed step and try again.';
          await steps.save('finalize', 'error');
          stepUpdate('finalize', 'error', message);
          send({ error: message, complete: false, hasErrors: true });
          await releaseSetupOperation(leaseOwnerId, leaseSessionId);
          finish();
          return;
        }
        assertProvisioningStepsComplete({ ...await getSetupSteps() });
        if (shouldRunStep('finalize')) {
          await heartbeatSetupOperation(leaseOwnerId, leaseSessionId);
          stepUpdate('finalize', 'running');
          await steps.started('finalize');

          await settingsService.setRaw({
            setup_completed: true,
            tls_choice: body.tls_choice || 'selfsigned',
          });
          // Clear setup_steps on successful completion (step times stay as a record)
          await spineClient.patchConfig({ setup_steps: {}, setup_step_errors: null });
          await steps.save('finalize', 'done');
          stepUpdate('finalize', 'done', 'Setup marked as complete');
        } else {
          stepUpdate('finalize', 'done', 'Already completed');
        }

        await markApplianceSetupComplete(leaseOwnerId, leaseSessionId);
        // Loads the SSO environment. Spine restarts once this run and any app work have ended, never under them.
        await spineClient.restartControl(5);
        settle();

        send({ complete: true, hasErrors: hasError });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('Setup failed:', err);
        await releaseSetupOperation(leaseOwnerId, leaseSessionId).catch(() => {});
      }

      finish();
      });
      } catch {
        await releaseSetupOperation(leaseOwnerId, leaseSessionId).catch(() => {});
        send({ error: 'Setup is blocked by retained lifecycle or System state. Reconcile the existing operation and retry.', complete: false, hasErrors: true });
        finish();
      } finally {
        endRun();
      }
    },
    cancel() { connected = false; },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
