/**
 * Unified App Market install API — SSE endpoint.
 * Handles both marketplace (OCI) and native (LXD) app installation.
 *
 * POST /api/market/install
 * Body: { appId, subdomain, domain }
 */

import { NextRequest } from 'next/server';
import { fetchManifest } from '@/lib/market/catalog';
import { installApp } from '@/lib/market/engine';
import { installNativeApp } from '@/lib/native-apps/installer';
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

  // Fetch manifest to determine app type
  let manifest;
  try {
    manifest = await fetchManifest(config.appId);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: `Failed to fetch manifest: ${err}` }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const isNative = manifest.type === 'native';
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
        if (isNative) {
          // Native app: use LXD deployer, driven by manifest metadata
          const nativeAppId = resolveNativeAppId(config.appId, manifest.native?.containerName);
          await installNativeApp(
            {
              appId: nativeAppId,
              subdomain: config.subdomain,
              domain: config.domain,
              installParams: config.installParams,
              customName: config.customName,
              customIcon: config.customIcon,
            },
            onEvent
          );
        } else {
          // Marketplace app: use OCI engine
          await installApp(manifest, config, onEvent, abortController.signal);
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

/**
 * Map unified manifest app IDs to the native installer's expected IDs.
 * Manifest uses "wiki"/"search", native installer expects "ye-wiki"/"ye-search".
 */
function resolveNativeAppId(manifestId: string, containerName?: string): string {
  // If the manifest already uses ye- prefix, use it as-is
  if (manifestId.startsWith('ye-')) return manifestId;
  // Map based on known native apps
  const mapping: Record<string, string> = {
    wiki: 'ye-wiki',
    search: 'ye-search',
    notes: 'ye-notes',
  };
  return mapping[manifestId] ?? `ye-${manifestId}`;
}
