/**
 * Install App from URL — SSE endpoint
 *
 * POST /api/market/install-url
 * Body: { manifestUrl, subdomain?, domain? }. The supported Spine CLI sends
 * `{ url }`; that alias derives the subdomain from the validated manifest.
 *
 * Fetches a manifest from a URL, validates it, then installs the app
 * using the same engine as catalog-based installs. Tracks the source
 * as 'url' for installed app metadata.
 *
 * Audit: Logs every URL install attempt using only the manifest origin host.
 */

import { NextRequest } from 'next/server';
import { installApp } from '@/lib/market/engine';
import { fetchUrlApp, UrlAppError, validateAppUrl } from '@/lib/market/url-app';
import {
  finishTracking, logOperationFailure, sanitiseInstallEvent, sensitivitySafeInstallError, startTracking, trackEvent,
} from '@/lib/market/install-tracker';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { settingsService } from '@/lib/settings';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { admissionAdministrator } from '@/lib/admission/management';
import type { AppManifest, InstallConfig, InstallEvent } from '@/lib/market/types';
import { saveDirectMarketApp } from '@/lib/market/direct-apps';

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
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return Response.json({ error: 'Invalid CSRF token' }, { status: 403 });
  }

  let body: { manifestUrl?: string; url?: string; subdomain?: string; domain?: string; acceptUnverifiedPublisher?: boolean; allowSetup?: boolean; adoptRetainedData?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }
  if (body.adoptRetainedData !== undefined && typeof body.adoptRetainedData !== 'boolean') {
    return Response.json({ error: 'Invalid adoption request' }, { status: 400 });
  }
  const actorId = await admissionAdministrator(auth.session);
  if (!actorId) {
    return Response.json({ error: 'Active administrator required' }, { status: 403 });
  }

  const manifestUrl = (body.manifestUrl ?? body.url)?.trim();
  const requestedSubdomain = body.subdomain?.trim().toLowerCase();

  if (!manifestUrl) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: manifestUrl' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (body.acceptUnverifiedPublisher !== true) {
    return new Response(
      JSON.stringify({ error: 'Confirm that you trust this Added app source before installing' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  if (requestedSubdomain && !validAppSubdomain(requestedSubdomain)) {
    return new Response(
      JSON.stringify({ error: 'Subdomain must be a single DNS label using lowercase letters, numbers, and hyphens' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  let domain: string;
  try {
    domain = await canonicalPlatformDomain();
    if (body.domain && body.domain !== domain) {
      console.warn(`[Market] Ignoring client-supplied URL install domain "${body.domain}", using platform domain "${domain}"`);
    }
  } catch {
    return new Response(
      JSON.stringify({ error: 'Platform domain is not configured' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate URL safety
  const urlError = validateAppUrl(manifestUrl);
  if (urlError) {
    return new Response(JSON.stringify({ error: urlError }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch and parse the app (manifest + setup files) with the one app-format parser
  let manifest: AppManifest;
  try {
    manifest = await fetchUrlApp(manifestUrl);
  } catch (error) {
    const details = error instanceof UrlAppError ? error.details : [];
    return new Response(JSON.stringify({
      error: error instanceof UrlAppError ? error.message : 'Manifest fetch or verification failed',
      ...(details.length ? { details } : {}),
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (manifest.setups.length > 0 && body.allowSetup !== true) {
    return new Response(JSON.stringify({
      error: 'This app runs setup files inside its containers; confirm them before installing (allowSetup)',
      setups: manifest.setups.map((setup) => ({ name: setup.name, for: setup.for })),
    }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const subdomain = requestedSubdomain
    || manifest.metadata.defaultSubdomain.trim().toLowerCase()
    || manifest.metadata.id;
  if (!validAppSubdomain(subdomain)) {
    return new Response(
      JSON.stringify({ error: 'Manifest default subdomain must be a single lowercase DNS label' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Audit log
  const sourceHost = (() => {
    try { return new URL(manifestUrl).host; } catch { return 'invalid-source'; }
  })();
  console.log(`[Market] URL install started from ${sourceHost} — app: ${manifest.metadata.id} v${manifest.version || 'unknown'} — subdomain: ${subdomain}.${domain}`);

  const appName = manifest.metadata?.name || manifest.metadata.id;
  const directEntry = await saveDirectMarketApp({ manifestUrl, manifest });
  const config: InstallConfig = {
    appId: manifest.metadata.id,
    admissionActorId: actorId || undefined,
    adoptRetainedData: body.adoptRetainedData,
    catalogKey: `${directEntry.sourceId}:app:${manifest.metadata.id}`,
    sourceId: directEntry.sourceId,
    sourceName: 'Added',
    sourceRepoUrl: directEntry.manifestUrl,
    manifestPath: directEntry.manifestUrl,
    manifestDigest: directEntry.manifestDigest,
    subdomain,
    domain,
  };

  // Start tracking this install for reconnection support
  let abortController: AbortController;
  try {
    abortController = startTracking(config.appId, appName);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Install operation could not start' }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // SSE stream installation progress
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let baseInstallComplete = false;
      const onEvent = (event: InstallEvent) => {
        const safeEvent = sanitiseInstallEvent(event);
        trackEvent(config.appId, safeEvent);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(safeEvent)}\n\n`));
        } catch { /* Stream closed */ }
      };

      try {
        await withUserOperationLockWait(
          () => installApp(manifest, config, onEvent, abortController.signal),
          { signal: abortController.signal },
        );
        baseInstallComplete = true;

        // After install, update metadata to track URL source
        const { updateInstalledAppSource } = await import('@/lib/market/installed-apps');
        await updateInstalledAppSource(manifest.metadata.id, 'url', manifestUrl);

        // Install succeeded
        finishTracking(config.appId);
        await sendNotificationToUI({
          title: `${appName} installed`,
          message: `${appName} has been installed successfully and is ready to use`,
          type: 'success',
          source: 'system',
          userId: null,
          appId: config.appId,
        }).catch(() => { /* best effort */ });
      } catch (err) {
        logOperationFailure(`URL install of ${config.appId}`, err);
        const errorMsg = sensitivitySafeInstallError(err);
        if (baseInstallComplete) {
          const { uninstallApp } = await import('@/lib/market/uninstaller');
          const rollback = await withUserOperationLockWait(
            () => uninstallApp(config.appId, { keepData: false }),
          ).catch(() => null);
          if (!rollback?.success) {
            onEvent({
              step: 0,
              totalSteps: 0,
              status: 'warning',
              message: 'URL install rollback retained cleanup_pending resources',
            });
          }
        }
        finishTracking(config.appId, errorMsg);

        const errorEvent: InstallEvent = {
          step: 0, totalSteps: 0, status: 'error',
          message: errorMsg, detail: errorMsg,
        };
        trackEvent(config.appId, errorEvent);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } catch { /* Stream closed */ }

        await sendNotificationToUI({
          title: `${appName} installation failed`,
          message: `Failed to install ${appName}; open System Health for cleanup and repair status.`,
          type: 'error',
          source: 'system',
          userId: null,
          appId: config.appId,
        }).catch(() => { /* best effort */ });
      } finally {
        try { controller.close(); } catch { /* Already closed */ }
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
