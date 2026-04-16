/**
 * Unified App Market install API — SSE endpoint.
 * Handles both marketplace (OCI) and native (LXD) app installation
 * through the single manifest-driven engine.
 *
 * POST /api/market/install
 * Body: { appId, subdomain, domain, installParams?, customName?, customIcon? }
 */

import { NextRequest } from 'next/server';
import { fetchManifest, fetchManifestFromRepo } from '@/lib/market/catalog';
import { installApp } from '@/lib/market/engine';
import { startTracking, trackEvent, finishTracking } from '@/lib/market/install-tracker';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { emitEvent } from '@/lib/events/emitter';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

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

  if (!config.appId || !config.subdomain || !config.domain) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: appId, subdomain, domain' }),
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
      manifest = await fetchManifest(config.appId);
    }
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to fetch manifest: ${err}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const appName = manifest.metadata?.name || config.appId;

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
        // Unified install path — engine handles both native (LXD) and marketplace (OCI)
        await installApp(manifest, config, onEvent, abortController.signal);

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
