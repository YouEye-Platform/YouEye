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
import { generateSetupAuthentikCSS } from '@/lib/authentik/setup-css';
import { generateWordArtSVG } from '@/lib/authentik/wordart-svg';
import { getIdentityConfig } from '@/lib/identity/config';
import {
  configureControlPanelIdentitySSO,
  configureUIIdentitySSO,
  ensureIdentityAdminUser,
} from '@/lib/identity/core-clients';
import { execShell } from '@/lib/incus/server';
import { tlsStorage } from '@/lib/acme/storage';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

interface SetupRequest {
  site_name: string;
  domain: string;
  subdomains: Record<string, string>;
  admin_first_name?: string;
  admin_last_name?: string;
  admin_username: string;
  admin_email: string;
  admin_password: string;
  site_name_style?: Record<string, unknown>;
  icon_config?: Record<string, unknown>;
  authentik_name?: string;
  /** TLS mode chosen during setup (letsencrypt, selfsigned, upload) */
  tls_choice?: string;
  /** If set, only run this specific step (retry mode) */
  retry_step?: string;
}

interface AuthentikConfig {
  url: string;
  token: string;
}

type StepState = 'pending' | 'done' | 'error';

interface SetupSteps {
  config?: StepState;
  caddy?: StepState;
  dns?: StepState;
  admin?: StepState;
  sso_control?: StepState;
  sso_ui?: StepState;
  finalize?: StepState;
}

async function getAuthentikConfig(): Promise<AuthentikConfig> {
  const creds = await spineClient.getAuthentikCredentials();
  const ip = await getContainerIP('youeye-authentik');
  const url = ip ? `http://${ip}:9000` : creds.internal_url;
  return { url, token: creds.bootstrap_token };
}

async function authentikAPI<T>(
  config: AuthentikConfig,
  path: string,
  method: string = 'GET',
  body?: Record<string, unknown>
): Promise<T> {
  const options: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.body = JSON.stringify(body);
  const res = await fetch(`${config.url}/api/v3${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Authentik API ${res.status}: ${text}`);
  }
  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
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
  if (!session?.isAdmin) {
    return new Response('Unauthorized', { status: 401 });
  }

  const csrfToken = request.headers.get('X-CSRF-Token');
  if (!csrfToken || !(await verifyCSRFToken(csrfToken))) {
    return new Response('Invalid CSRF token', { status: 403 });
  }

  const body: SetupRequest = await request.json();
  // Sanitize domain: strip trailing dots (e.g. "potemk." → "potemk")
  // Trailing dots produce URLs like "https://control.potemk." which Authentik rejects
  if (body.domain) {
    body.domain = body.domain.replace(/\.+$/, '');
  }
  const retryStep = body.retry_step;

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
        const akIp = await getContainerIP('youeye-authentik');
        const phIp = await getContainerIP('youeye-pihole');
        const caddyIp = await getContainerIP('youeye-caddy');
        const [akOk, phOk, caddyOk, spineOk] = await Promise.all([
          akIp ? checkConnectivity('Authentik', `http://${akIp}:9000/-/health/ready/`) : Promise.resolve(false),
          phIp ? checkConnectivity('Pi-Hole', `http://${phIp}:80/api/info/version`) : Promise.resolve(false),
          caddyIp ? checkConnectivity('Caddy', `http://${caddyIp}:2019/config/`) : Promise.resolve(false),
          spineClient.isAvailable(),
        ]);
        send({
          connectivity: {
            authentik: akOk,
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
          stepUpdate('config', 'running');
          const authentikName = body.authentik_name || `${body.site_name || 'YouEye'} ID`;
          await settingsService.setRaw({
            site_name: body.site_name || 'YouEye',
            domain: body.domain,
            subdomains: body.subdomains,
            identity: { provider: 'youeye-id' },
            authentik_name: authentikName,
            setup_completed: false,
          });
          await saveStepState('config', 'done');
          stepUpdate('config', 'done', 'Configuration saved');
        } else {
          stepUpdate('config', 'done', 'Already completed');
        }

        // ── Step 2: Caddy reverse proxy ──────────────────────────────
        if (shouldRunStep('caddy')) {
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

          // If an ACME cert was already issued during setup (LE flow in step 0),
          // restore it now — setDomain() resets TLS policies to self-signed
          if (!hasError) {
            try {
              const storedCert = await tlsStorage.getCert();
              if (storedCert && storedCert.mode === 'acme') {
                await caddy.loadExternalCert(storedCert.certPem, storedCert.keyPem, storedCert.domains);
                console.log('[setup] Restored ACME certificate after setDomain');
              }
            } catch (certErr) {
              console.warn('[setup] Non-fatal: could not restore ACME cert:', certErr);
            }
          }

          if (!hasError || retryStep === 'caddy') {
            if (!subs.identity) {
              throw new Error('YouEye ID subdomain is missing. Set subdomains.identity before provisioning.');
            }

            // Route mappings — setContainerRoute is already idempotent (Caddy overwrites existing routes)
            const routeMap: Array<{ sub: string; container: string; port: number }> = [
              { sub: subs.control || 'control', container: 'youeye-control', port: 3000 },
              { sub: subs.auth || 'auth', container: 'youeye-authentik', port: 9000 },
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
              console.error('Failed to create YouEye ID route:', err);
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

        // ── Step 3: Admin user in Authentik (already idempotent) ─────
        if (shouldRunStep('admin')) {
          stepUpdate('admin', 'running');

          // Connectivity pre-check
          const akConfig = await getAuthentikConfig();
          const akReachable = await checkConnectivity('Authentik', `${akConfig.url}/-/health/ready/`);
          if (!akReachable) {
            await saveStepState('admin', 'error');
            stepUpdate('admin', 'error', 'Authentik is unreachable — cannot create admin user');
            hasError = true;
          } else {
            // Check if user already exists (idempotent)
            const existingUsers = await authentikAPI<{ results: Array<{ pk: number; username: string }> }>(
              akConfig, `/core/users/?search=${encodeURIComponent(body.admin_username)}`
            );
            // Filter to exact username match
            const exactMatch = existingUsers.results?.find(u => u.username === body.admin_username);

            let userId: number;
            if (exactMatch) {
              userId = exactMatch.pk;
              // Update name/email if provided
              // Note: Authentik only has a single "name" field (no first_name/last_name).
              // Our custom OIDC scope mapping splits "name" into given_name/family_name.
              const patchData: Record<string, string> = {};
              const fullNameForPatch = [body.admin_first_name, body.admin_last_name].filter(Boolean).join(' ');
              if (fullNameForPatch) patchData.name = fullNameForPatch;
              if (body.admin_email) patchData.email = body.admin_email;
              if (Object.keys(patchData).length > 0) {
                await authentikAPI(akConfig, `/core/users/${userId}/`, 'PATCH', patchData);
              }
              await authentikAPI(akConfig, `/core/users/${userId}/set_password/`, 'POST', {
                password: body.admin_password,
              });
              stepUpdate('admin', 'done', `Updated existing user "${body.admin_username}"`);
            } else {
              // Authentik only has a single "name" field — no first_name/last_name.
              const fullName = [body.admin_first_name, body.admin_last_name].filter(Boolean).join(' ') || body.admin_username;
              const user = await authentikAPI<{ pk: number }>(akConfig, '/core/users/', 'POST', {
                username: body.admin_username,
                name: fullName,
                email: body.admin_email,
                is_active: true,
              });
              userId = user.pk;
              await authentikAPI(akConfig, `/core/users/${userId}/set_password/`, 'POST', {
                password: body.admin_password,
              });
              stepUpdate('admin', 'done', `Created admin user "${body.admin_username}"`);
            }

            // Ensure user is in "authentik Admins" group
            try {
              const groups = await authentikAPI<{ results: Array<{ pk: string; name: string }> }>(
                akConfig, '/core/groups/?search=authentik+Admins'
              );
              const adminsGroup = groups.results?.find(g => g.name === 'authentik Admins');
              if (adminsGroup) {
                const groupDetail = await authentikAPI<{ users: number[] }>(
                  akConfig, `/core/groups/${adminsGroup.pk}/`
                );
                const currentUsers = groupDetail.users || [];
                if (!currentUsers.includes(userId)) {
                  await authentikAPI(akConfig, `/core/groups/${adminsGroup.pk}/`, 'PATCH', {
                    users_obj: undefined,
                    users: [...currentUsers, userId],
                  });
                }
              }
            } catch {
              // Group assignment is optional
            }

            // Set Authentik brand title
            const authentikName = body.authentik_name || `${body.site_name || 'YouEye'} ID`;
            try {
              const brands = await authentikAPI<{ results: Array<{ pk: string; brand_uuid: string; default: boolean }> }>(
                akConfig, '/core/brands/'
              );
              const defaultBrand = brands.results?.find(b => b.default) || brands.results?.[0];
              if (defaultBrand) {
                await authentikAPI(akConfig, `/core/brands/${defaultBrand.brand_uuid}/`, 'PATCH', {
                  branding_title: authentikName,
                });
              }
            } catch {
              // Non-critical
            }

            await ensureIdentityAdminUser({
              username: body.admin_username,
              password: body.admin_password,
              name: [body.admin_first_name, body.admin_last_name].filter(Boolean).join(' ') || body.admin_username,
              email: body.admin_email,
            });

            await saveStepState('admin', 'done');
          }
        } else {
          stepUpdate('admin', 'done', 'Already completed');
        }

        // ── Step 4: SSO for Control Panel (idempotent) ───────────────
        if (shouldRunStep('sso_control')) {
          stepUpdate('sso_control', 'running');
          const domain = body.domain;
          const subs = body.subdomains || {};
          const controlHost = `${subs.control || 'control'}.${domain}`;
          await configureControlPanelIdentitySSO({
            controlExternalUrl: `https://${controlHost}`,
            settingsExternalUrl: `https://${domain}/settings`,
          });
          await saveStepState('sso_control', 'done');
          stepUpdate('sso_control', 'done', 'YouEye ID configured for Control Panel');
        } else {
          stepUpdate('sso_control', 'done', 'Already completed');
        }

        // ── Step 5: SSO for UI + enable (idempotent) ─────────────────
        if (shouldRunStep('sso_ui')) {
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
                stepUpdate('sso_ui', 'done', 'UI enabled and YouEye ID configured');
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
          stepUpdate('finalize', 'running');
          await settingsService.setRaw({ setup_completed: true });
          // Clear setup_steps on successful completion
          await spineClient.patchConfig({ setup_steps: {} });
          await saveStepState('finalize', 'done');
          stepUpdate('finalize', 'done', 'Setup marked as complete');
        } else {
          stepUpdate('finalize', 'done', 'Already completed');
        }

        // ── Sync Authentik branding (title + logo + CSS) (non-fatal) ──
        try {
          const akConfig = await getAuthentikConfig();
          const brandsRes = await authentikAPI<{ results: Array<{ brand_uuid: string; default: boolean }> }>(
            akConfig, '/core/brands/'
          );
          const defaultBrand = brandsRes.results.find(b => b.default);
          if (defaultBrand) {
            const rawName = body.site_name || 'YouEye';
            const brandingTitle = `${rawName} ID`;
            const siteNameStyle = body.site_name_style as Record<string, unknown> | undefined;

            // Copy font files into Authentik and detect format
            const fontSlugFn = (name: string) => name.toLowerCase().replace(/\s+/g, '-');
            let setupFontFormat: 'woff2' | 'truetype' = 'truetype';
            let setupFontFiles: string[] | undefined;
            const fontsToSync = ['inter'];
            if ((siteNameStyle as Record<string, unknown>)?.fontFamily && (siteNameStyle as Record<string, unknown>)?.fontFamily !== 'Inter') {
              const slug = fontSlugFn((siteNameStyle as Record<string, unknown>).fontFamily as string);
              fontsToSync.push(slug);
            }
            for (const slug of fontsToSync) {
              try {
                const srcDir = join(process.cwd(), 'public', 'fonts', slug);
                if (!existsSync(srcDir)) continue;
                const destDir = `/web/dist/assets/fonts/${slug}`;
                await execShell('youeye-authentik', `mkdir -p ${destDir}`);
                const files = readdirSync(srcDir).filter(f => /\.(ttf|woff2?|otf)$/.test(f));
                if (slug !== 'inter') {
                  setupFontFiles = files;
                  if (files.some(f => f.endsWith('.woff2'))) {
                    setupFontFormat = 'woff2';
                  }
                }
                for (const file of files) {
                  const data = readFileSync(join(srcDir, file));
                  const b64 = data.toString('base64');
                  const CHUNK = 65536;
                  if (b64.length > CHUNK) {
                    await execShell('youeye-authentik', `rm -f ${destDir}/${file}`);
                    for (let off = 0; off < b64.length; off += CHUNK) {
                      const chunk = b64.slice(off, off + CHUNK);
                      await execShell('youeye-authentik', `printf '%s' '${chunk}' >> ${destDir}/${file}.b64`);
                    }
                    await execShell('youeye-authentik', `base64 -d ${destDir}/${file}.b64 > ${destDir}/${file} && rm ${destDir}/${file}.b64`);
                  } else {
                    await execShell('youeye-authentik', `printf '%s' '${b64}' | base64 -d > ${destDir}/${file}`);
                  }
                }
                console.log(`[setup] Copied ${files.length} font files for ${slug} to Authentik`);
              } catch (fontErr) {
                console.warn(`[setup] Non-fatal: font copy failed for ${slug}:`, fontErr);
              }
            }

            const brandingCSS = generateSetupAuthentikCSS(siteNameStyle ?? null, body.domain, rawName, setupFontFormat, setupFontFiles);

            // Generate WordArt SVG for branding_logo (used in dashboard header).
            // Login flow uses CSS ::part(branding)::after for pixel-perfect matching.
            let brandingLogo = '/static/dist/assets/icons/icon.png';
            try {
              const svg = generateWordArtSVG(rawName, siteNameStyle as never);
              const escapedSvg = svg.replace(/'/g, "'\\''");
              await execShell(
                'youeye-authentik',
                `mkdir -p /web/dist/assets/icons && cat > /web/dist/assets/icons/youeye-wordart.svg << 'SVGEOF'\n${escapedSvg}\nSVGEOF`
              );
              brandingLogo = '/static/dist/assets/icons/youeye-wordart.svg';
              console.log(`[setup] Generated WordArt SVG logo for "${rawName}"`);
            } catch (svgErr) {
              console.warn('[setup] Non-fatal: SVG logo generation failed:', svgErr);
            }

            // Push favicon to Authentik if icon_config was provided
            let brandingFavicon: string | undefined;
            if (body.icon_config) {
              try {
                // Try to render icon via UI's API (letter mode can be server-rendered)
                const uiIP = await getContainerIP('youeye-ui');
                if (uiIP) {
                  const faviconRes = await fetch(`http://${uiIP}:3000/api/v1/branding/icon?size=192`, {
                    signal: AbortSignal.timeout(5000),
                  });
                  if (faviconRes.ok) {
                    const faviconBuf = Buffer.from(await faviconRes.arrayBuffer());
                    const faviconB64 = faviconBuf.toString('base64');
                    await execShell(
                      'youeye-authentik',
                      `printf '%s' '${faviconB64}' | base64 -d > /web/dist/assets/icons/youeye-favicon.png`
                    );
                    brandingFavicon = '/static/dist/assets/icons/youeye-favicon.png';
                    console.log('[setup] Pushed custom favicon to Authentik');
                  }
                }
              } catch (favErr) {
                console.warn('[setup] Non-fatal: favicon push failed:', favErr);
              }
            }

            await authentikAPI(akConfig, `/core/brands/${defaultBrand.brand_uuid}/`, 'PATCH', {
              branding_title: brandingTitle,
              branding_logo: brandingLogo,
              branding_custom_css: brandingCSS,
              ...(brandingFavicon ? { branding_favicon: brandingFavicon } : {}),
            });
            console.log(`[setup] Set Authentik branding_title to "${brandingTitle}" with custom CSS (${brandingCSS.length} chars)`);

            // Update flow titles to match the site name
            const flowTitle = `Welcome home!`;
            const flowSlugs = ['default-authentication-flow', 'default-source-authentication', 'initial-setup'];
            for (const slug of flowSlugs) {
              try {
                await authentikAPI(akConfig, `/flows/instances/${slug}/`, 'PATCH', { title: flowTitle });
              } catch {
                // Non-fatal — flow may not exist
              }
            }
            console.log(`[setup] Updated Authentik flow titles to "${flowTitle}"`);

            // Enable attributes.avatar so custom user avatars work
            try {
              await authentikAPI(akConfig, '/admin/settings/', 'PATCH', {
                avatars: 'attributes.avatar,gravatar,initials',
              });
              console.log('[setup] Enabled attributes.avatar in Authentik settings');
            } catch {
              console.warn('[setup] Non-fatal: could not set avatar mode');
            }
          }
        } catch (err) {
          console.warn('[setup] Non-fatal: Authentik branding sync failed:', err);
        }

        send({ complete: true, hasErrors: hasError });
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        send({ error: message });
        console.error('Setup failed:', err);
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
