/**
 * Unified Market install API — SSE endpoint.
 * Handles both Market-installed (OCI) and native (LXD) app installation
 * through the single manifest-driven engine.
 *
 * POST /api/market/install
 * Body: { appId, subdomain?, domain?, sourceId?, installParams?, customName?, customIcon? }
 *
 * Only appId is required. When the caller omits subdomain/sourceId (e.g. the
 * `youeye app install` CLI), they are resolved server-side from the catalog:
 * sourceId defaults to the default Market source and subdomain defaults to
 * the manifest's defaultSubdomain (falling back to the appId). This keeps
 * install records complete — a record persisted without catalog metadata
 * silently disables update detection.
 */

import { NextRequest } from 'next/server';
import { fetchAvailableApps, fetchManifestFromRepo, fetchManifestFromSource, fetchManifestReferenceFromSource } from '@/lib/market/catalog';
import { getMarketSource } from '@/lib/market/source';
import { installApp } from '@/lib/market/engine';
import { applyIntegration } from '@/lib/market/integration-runner';
import { uninstallApp } from '@/lib/market/uninstaller';
import { finishTracking, sanitiseInstallEvent, sensitivitySafeInstallError, startTracking, trackEvent } from '@/lib/market/install-tracker';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { emitEvent } from '@/lib/events/emitter';
import { settingsService } from '@/lib/settings';
import { assertNoCriticalIssues } from '@/lib/health/issues';
import { requireAdmin } from '@/lib/auth/rbac';
import { getUserByUsername } from '@/lib/identity/store';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';
import { getDirectMarketApp } from '@/lib/market/direct-apps';
import { updateInstalledAppSource } from '@/lib/market/installed-apps';

export const dynamic = 'force-dynamic';

function validAppSubdomain(value: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
}

async function canonicalPlatformDomain(): Promise<string> {
  const settings = await settingsService.getRaw();
  const domain = typeof settings.domain === 'string' ? settings.domain.trim() : '';
  if (!domain) {
    throw new Error('Platform domain is not configured');
  }
  return domain;
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  try {
    await assertNoCriticalIssues('App install');
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'App installs are blocked by a critical Health issue' }),
      { status: 423, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let config: InstallConfig;
  try {
    config = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!config.appId && !config.repoUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: appId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Resolve the Market source server-side when omitted so the install record
  // always carries a real sourceId (update detection depends on it).
  if (!config.repoUrl && !config.sourceId) {
    try {
      config.sourceId = (await getMarketSource()).id;
    } catch {
      return new Response(
        JSON.stringify({ error: 'Failed to resolve the configured Market source' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  try {
    const canonicalDomain = await canonicalPlatformDomain();
    if (config.domain && config.domain !== canonicalDomain) {
      console.warn(`[Market] Ignoring client-supplied install domain "${config.domain}", using platform domain "${canonicalDomain}"`);
    }
    config.domain = canonicalDomain;
  } catch {
    return new Response(
      JSON.stringify({ error: 'Platform domain is not configured' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Fetch manifest — from repo URL (custom install) or catalog
  let manifest;
  try {
    if (config.sourceId?.startsWith('direct:')) {
      if (config.acceptUnverifiedPublisher !== true) {
        throw new Error('Confirm that you trust this Added app source before installing');
      }
      const direct = await getDirectMarketApp(config.sourceId, config.appId);
      if (!direct) throw new Error('Direct Market entry no longer exists');
      manifest = direct.manifest;
      config.catalogKey = `${direct.sourceId}:app:${direct.manifest.metadata.id}`;
      config.sourceName = 'Added';
      config.sourceRepoUrl = direct.manifestUrl;
      config.manifestPath = direct.manifestUrl;
      config.manifestDigest = direct.manifestDigest;
    } else if (config.repoUrl) {
      manifest = await fetchManifestFromRepo(config.repoUrl, 'youeye-app.yaml', config.repoBranch);
      // Override appId from manifest if not explicitly set
      if (!config.appId || config.appId === 'custom') {
        config.appId = manifest.metadata.id;
      }
    } else {
      manifest = await fetchManifestFromSource(config.appId, config.sourceId);
      if (!config.manifestDigest) {
        const reference = await fetchManifestReferenceFromSource(config.appId, config.sourceId);
        config.manifestPath = reference.path;
        config.manifestRepo = reference.repo;
        config.manifestBranch = reference.branch;
        config.manifestDigest = reference.digest;
      }
    }
  } catch (error) {
    const directError = config.sourceId?.startsWith('direct:') && error instanceof Error
      ? error.message
      : 'Failed to fetch or verify the app manifest';
    return new Response(
      JSON.stringify({ error: directError }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  delete config.acceptUnverifiedPublisher;

  const appName = manifest.metadata?.name || config.appId;

  // Never trust client-supplied Pointer owner or credential fields. AI-capable
  // apps default to the signed-in administrator's AI Settings; CLI/PAM-only
  // sessions may still install in manual-provider mode explicitly.
  if (manifest.capabilities?.ai_api) {
    const enabled = config.aiSettings?.enabled !== false;
    if (enabled) {
      const identityUser = await getUserByUsername(auth.session.username);
      if (!identityUser) {
        return new Response(
          JSON.stringify({ error: 'Using AI Settings requires a YouEye user account; turn it off to configure providers inside the app' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      config.aiSettings = {
        enabled: true,
        modelGroupId: config.aiSettings?.modelGroupId,
        ownerUserId: identityUser.id,
        ownerDisplayName: identityUser.name || identityUser.username,
      };
    } else {
      config.aiSettings = { enabled: false };
    }
  } else {
    delete config.aiSettings;
  }

  // Default the subdomain from the manifest when the caller omitted it
  // (CLI installs send only appId) — same pattern as the bundle installer.
  if (!config.subdomain) {
    config.subdomain = manifest.metadata?.defaultSubdomain || config.appId;
  }
  config.subdomain = config.subdomain.trim().toLowerCase();
  if (!validAppSubdomain(config.subdomain)) {
    return new Response(
      JSON.stringify({ error: 'Subdomain must be a single DNS label using lowercase letters, numbers, and hyphens' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Validate required install params
  if (manifest.installParams?.length) {
    const errors: string[] = [];
    for (const param of manifest.installParams) {
      if (param.required && !config.installParams?.[param.name]) {
        errors.push(`Missing required parameter: ${param.label || param.name}`);
      }
      if (param.validation?.pattern && config.installParams?.[param.name]) {
        const re = new RegExp(param.validation.pattern);
        if (!re.test(config.installParams[param.name])) {
          errors.push(param.validation.message || `Invalid value for ${param.label || param.name}`);
        }
      }
    }
    if (errors.length > 0) {
      return new Response(
        JSON.stringify({ error: errors.join('; ') }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  // Start tracking this install for reconnection support (returns AbortController)
  let abortController: AbortController;
  try {
    abortController = startTracking(config.appId, appName);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Install operation could not start' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: InstallEvent) => {
        const safeEvent = sanitiseInstallEvent(event);
        // Track event for reconnection support
        trackEvent(config.appId, safeEvent);
        const data = `data: ${JSON.stringify(safeEvent)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed by client
        }
      };

      try {
        const selectedStandaloneIntegrations = config.sourceId?.startsWith('direct:')
          ? []
          : await getSelectedStandaloneIntegrations(config.appId, config.sourceId, config.selectedIntegrations);
        config.plannedNativeIdentityIntegration = selectedStandaloneIntegrations.some((integration) => integration.type === 'identity');
        let baseInstallComplete = false;

        // Unified install path — engine handles both native (LXD) and Market-installed (OCI)
        await installApp(manifest, config, onEvent, abortController.signal);
        baseInstallComplete = true;
        if (config.sourceId?.startsWith('direct:') && config.sourceRepoUrl) {
          await updateInstalledAppSource(config.appId, 'url', config.sourceRepoUrl);
        }

        for (const integrationId of selectedStandaloneIntegrations) {
          try {
            await applyIntegration(
              { integrationId: integrationId.id, sourceId: config.sourceId },
              onEvent
            );
          } catch (integrationErr) {
            if (baseInstallComplete) {
              onEvent({
                step: 0,
                totalSteps: 0,
                status: 'running',
                message: 'Rolling back failed install after integration error...',
                detail: 'Integration activation failed; generated diagnostic detail was withheld.',
              });
              const rollback = await uninstallApp(config.appId, { keepData: false, dropSharedDatabase: true }).catch(() => {
                onEvent({
                  step: 0,
                  totalSteps: 0,
                  status: 'warning',
                  message: 'Rollback after integration error did not fully complete',
                  detail: 'Use the supported Health and repair views for sensitivity-safe diagnostics.',
                });
                return null;
              });
              if (!rollback?.success) {
                onEvent({
                  step: 0,
                  totalSteps: 0,
                  status: 'warning',
                  message: 'Rollback after integration error retained cleanup_pending resources',
                });
              }
            }
            throw integrationErr;
          }
        }

        // Install succeeded
        finishTracking(config.appId);
        emitEvent('app.installed', { appId: config.appId, appName, subdomain: config.subdomain });
        await sendNotificationToUI({
          title: `${appName} installed`,
          message: `${appName} has been installed successfully and is ready to use`,
          type: 'success',
          source: 'system',
          userId: null,
          appId: config.appId,
        }).catch(() => { /* best effort */ });
      } catch (err) {
        const errorMsg = sensitivitySafeInstallError(err);
        finishTracking(config.appId, errorMsg);

        const errorEvent: InstallEvent = {
          step: 0,
          totalSteps: 0,
          status: 'error',
          message: errorMsg,
          detail: errorMsg,
        };
        trackEvent(config.appId, errorEvent);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } catch {
          // Stream closed
        }

        await sendNotificationToUI({
          title: `${appName} installation failed`,
          message: `Failed to install ${appName}; open System Health for cleanup and repair status.`,
          type: 'error',
          source: 'system',
          userId: null,
          appId: config.appId,
        }).catch(() => { /* best effort */ });
      } finally {
        try {
          controller.close();
        } catch {
          // Already closed
        }
      }
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

async function getSelectedStandaloneIntegrations(
  appId: string,
  sourceId?: string,
  selectedIntegrations?: string[],
): Promise<{ id: string; type?: string }[]> {
  if (!selectedIntegrations?.length) return [];

  const selected = new Set(selectedIntegrations);
  const apps = await fetchAvailableApps();

  return apps
    .filter((item) => (
      item.itemKind === 'integration' &&
      item.target?.appId === appId &&
      selected.has(item.id) &&
      (!sourceId || item.sourceId === sourceId)
    ))
    .map((item) => ({ id: item.id, type: item.integrations?.[0]?.type }));
}
