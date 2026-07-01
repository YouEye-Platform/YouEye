/**
 * Unified Market install API — SSE endpoint.
 * Handles both Market-installed (OCI) and native (LXD) app installation
 * through the single manifest-driven engine.
 *
 * POST /api/market/install
 * Body: { appId, subdomain, domain, installParams?, customName?, customIcon? }
 */

import { NextRequest } from 'next/server';
import { fetchAvailableApps, fetchManifestFromRepo, fetchManifestFromSource, fetchManifestReferenceFromSource } from '@/lib/market/catalog';
import { installApp } from '@/lib/market/engine';
import { applyIntegration } from '@/lib/market/integration-runner';
import { uninstallApp } from '@/lib/market/uninstaller';
import { startTracking, trackEvent, finishTracking } from '@/lib/market/install-tracker';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { emitEvent } from '@/lib/events/emitter';
import { settingsService } from '@/lib/settings';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';

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
  let config: InstallConfig;
  try {
    config = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!config.appId || !config.subdomain) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: appId, subdomain' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  config.subdomain = config.subdomain.trim().toLowerCase();
  if (!validAppSubdomain(config.subdomain)) {
    return new Response(
      JSON.stringify({ error: 'Subdomain must be a single DNS label using lowercase letters, numbers, and hyphens' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  try {
    const canonicalDomain = await canonicalPlatformDomain();
    if (config.domain && config.domain !== canonicalDomain) {
      console.warn(`[Market] Ignoring client-supplied install domain "${config.domain}", using platform domain "${canonicalDomain}"`);
    }
    config.domain = canonicalDomain;
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Platform domain is not configured' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Fetch manifest — from repo URL (custom install) or catalog
  let manifest;
  try {
    if (config.repoUrl) {
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
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to fetch manifest: ${err}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const appName = manifest.metadata?.name || config.appId;

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
  const abortController = startTracking(config.appId, appName);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: InstallEvent) => {
        // Track event for reconnection support
        trackEvent(config.appId, event);
        const data = `data: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream may have been closed by client
        }
      };

      try {
        const selectedStandaloneIntegrations = await getSelectedStandaloneIntegrations(config.appId, config.sourceId, config.selectedIntegrations);
        config.plannedNativeIdentityIntegration = selectedStandaloneIntegrations.some((integration) => integration.type === 'identity');
        let baseInstallComplete = false;

        // Unified install path — engine handles both native (LXD) and Market-installed (OCI)
        await installApp(manifest, config, onEvent, abortController.signal);
        baseInstallComplete = true;

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
                detail: String(integrationErr),
              });
              await uninstallApp(config.appId, { keepData: false, dropSharedDatabase: true }).catch((rollbackErr) => {
                onEvent({
                  step: 0,
                  totalSteps: 0,
                  status: 'warning',
                  message: 'Rollback after integration error did not fully complete',
                  detail: String(rollbackErr),
                });
              });
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
        const errorMsg = String(err);
        finishTracking(config.appId, errorMsg);

        const errorEvent: InstallEvent = {
          step: 0,
          totalSteps: 0,
          status: 'error',
          message: 'Installation failed',
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
          message: `Failed to install ${appName}: ${errorMsg}`,
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
