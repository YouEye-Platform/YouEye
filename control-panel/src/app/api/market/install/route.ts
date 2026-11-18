/**
 * Unified Market install API — SSE endpoint.
 * Handles both Market-installed (OCI) and native (LXD) app installation
 * through the single manifest-driven engine.
 *
 * POST /api/market/install
 * Body: { appId, subdomain?, domain?, sourceId?, customName?, customIcon? }
 *
 * Only appId is required. When the caller omits subdomain/sourceId (e.g. the
 * `youeye app install` CLI), they are resolved server-side: sourceId defaults
 * to the official Market (never "the first enabled source") and subdomain
 * defaults to the manifest's defaultSubdomain (falling back to the appId).
 * A custom source must be accepted by the owner and an Added (URL) app needs
 * its own consent flags (`marketSourceRefusal`, `directAppRefusal`); the
 * source identity in the record is always set here, never by the client.
 */

import { NextRequest } from 'next/server';
import { isMarketAppUnavailable, resolveCatalogApp } from '@/lib/market/catalog';
import { directAppRefusal, isMarketSourceConsentError, OFFICIAL_MARKET_SOURCE_ID } from '@/lib/market/source';
import { installApp } from '@/lib/market/engine';
import {
  finishTracking, logOperationFailure, sanitiseInstallEvent, sensitivitySafeInstallError, startTracking, trackEvent,
} from '@/lib/market/install-tracker';
import { withUserOperationLockWait } from '@/lib/market/update-admission';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { emitEvent } from '@/lib/events/emitter';
import { settingsService } from '@/lib/settings';
import { hasOpenCriticalIssue } from '@/lib/health/issues';
import { requireAdmin } from '@/lib/auth/rbac';
import { verifyCSRFToken } from '@/lib/auth/session';
import { admissionAdministrator } from '@/lib/admission/management';
import { getUserByUsername } from '@/lib/identity/store';
import { resolveInstallAISettings } from '@/lib/market/install-ai-settings';
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
  if (!await verifyCSRFToken(request.headers.get('X-CSRF-Token') || '')) {
    return Response.json({ error: 'Invalid CSRF token' }, { status: 403 });
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

  // Box-level critical issues, or one of this same app, block the install; another app's never does.
  let blocking;
  try {
    blocking = await hasOpenCriticalIssue(typeof config?.appId === 'string' ? config.appId : undefined);
  } catch (err) {
    logOperationFailure('Reading health issues before an install', err);
    return Response.json({ error: 'Health status is unavailable; try again shortly' }, { status: 503 });
  }
  if (blocking) {
    return Response.json({ error: `App install blocked while critical health issue is open: ${blocking.title}` }, { status: 423 });
  }
  // Browser JSON cannot nominate an owner. Authenticated CLI/PAM installs
  // resolve the authoritative appliance claim, including after delete-data.
  delete config.admissionActorId;
  delete config.admissionInstallationId;
  delete config.admissionDataOwnerId;
  delete config.admissionResourceOwners;
  const actorId = await admissionAdministrator(auth.session);
  if (!actorId) return Response.json({ error: 'Active administrator required' }, { status: 403 });
  config.admissionActorId = actorId;
  if (config.adoptRetainedData !== undefined && typeof config.adoptRetainedData !== 'boolean') {
    return Response.json({ error: 'Invalid adoption request' }, { status: 400 });
  }
  if (config.publicAccess !== undefined && typeof config.publicAccess !== 'boolean') {
    return Response.json({ error: 'Invalid public access choice' }, { status: 400 });
  }

  if (!config.appId) {
    return new Response(
      JSON.stringify({ error: 'Missing required field: appId' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (config.sourceId !== undefined && typeof config.sourceId !== 'string') {
    return Response.json({ error: 'Invalid Market source' }, { status: 400 });
  }
  // The official Market unless the caller named a source, so the install record always carries a real sourceId
  // (update detection depends on it). Catalog identity fields come from the resolved source, never the client.
  config.sourceId = config.sourceId?.trim() || OFFICIAL_MARKET_SOURCE_ID;
  delete config.catalogKey;
  delete config.sourceName;
  delete config.sourceRepoUrl;
  delete config.manifestPath;
  delete config.manifestRepo;
  delete config.manifestBranch;
  delete config.manifestDigest;

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

  // Fetch the manifest: from an Added app (direct source) or the catalog
  let manifest;
  try {
    if (config.sourceId.startsWith('direct:')) {
      const direct = await getDirectMarketApp(config.sourceId, config.appId);
      if (!direct) throw new Error('Direct Market entry no longer exists');
      const refusal = directAppRefusal(direct.manifest.setups, config);
      if (refusal) throw refusal;
      manifest = direct.manifest;
      config.catalogKey = `${direct.sourceId}:app:${direct.manifest.metadata.id}`;
      config.sourceName = 'Added';
      config.sourceRepoUrl = direct.manifestUrl;
      config.manifestPath = direct.manifestUrl;
      config.manifestDigest = direct.manifestDigest;
    } else {
      const resolved = await resolveCatalogApp(config.appId, config.sourceId);
      manifest = resolved.manifest;
      config.catalogKey = `${resolved.source.id}:app:${config.appId}`;
      config.sourceName = resolved.source.name;
      config.sourceRepoUrl = resolved.source.url || undefined;
      config.manifestPath = resolved.reference.path;
      config.manifestRepo = resolved.reference.repo;
      config.manifestBranch = resolved.reference.branch;
      config.manifestDigest = resolved.reference.digest;
    }
  } catch (error) {
    if (isMarketSourceConsentError(error)) {
      return Response.json({ error: error.message, code: error.code, ...(error.setups ? { setups: error.setups } : {}) },
        { status: error.code === 'source-unavailable' ? 400 : 403 });
    }
    // The app needs a newer YouEye than this box runs: refused with that reason and the version it needs.
    if (isMarketAppUnavailable(error)) {
      return Response.json({ error: error.message, code: error.code, ...(error.needsYouEye ? { needsYouEye: error.needsYouEye } : {}) }, { status: 409 });
    }
    // resolveCatalogApp's own messages name only the app, the source and the reason its market or manifest gave.
    const directError = error instanceof Error && (config.sourceId?.startsWith('direct:')
      || /^App "[^"]*" could not be resolved from Market source/.test(error.message))
      ? error.message
      : 'Failed to fetch or verify the app manifest';
    return new Response(
      JSON.stringify({ error: directError }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
  delete config.acceptUnverifiedPublisher;
  delete config.allowSetup;

  const appName = manifest.metadata?.name || config.appId;

  // Never trust client-supplied Pointer owner or credential fields. AI-capable
  // apps default to the signed-in administrator's AI Settings; a CLI session
  // has no YouEye ID user, so its installs default to AI Settings off.
  if (manifest.capabilities?.ai_api) {
    const user = auth.session.authMethod === 'cli' ? null : await getUserByUsername(auth.session.username);
    const decision = resolveInstallAISettings(config.aiSettings, user);
    if ('error' in decision) {
      return new Response(
        JSON.stringify({ error: decision.error }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    config.aiSettings = decision.aiSettings;
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
        // Unified install path — engine handles both native (LXD) and Market-installed (OCI)
        await withUserOperationLockWait(
          () => installApp(manifest, config, onEvent, abortController.signal),
          { signal: abortController.signal },
        );
        if (config.sourceId?.startsWith('direct:') && config.sourceRepoUrl) {
          await updateInstalledAppSource(config.appId, 'url', config.sourceRepoUrl);
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
        logOperationFailure(`Install of ${config.appId}`, err);
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
