/**
 * Install App from URL — SSE endpoint
 *
 * POST /api/market/install-url
 * Body: { manifestUrl, subdomain, domain }
 *
 * Fetches a manifest from a URL, validates it, then installs the app
 * using the same engine as catalog-based installs. Tracks the source
 * as 'url' for installed app metadata.
 *
 * Audit: Logs every URL install attempt with the full manifest URL.
 */

import { NextRequest } from 'next/server';
import { parse as parseYAML } from 'yaml';
import { AppManifestSchema } from '@/lib/market/schema';
import { installApp } from '@/lib/market/engine';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { startTracking, trackEvent, finishTracking } from '@/lib/market/install-tracker';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';

export const dynamic = 'force-dynamic';

const MAX_SIZE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 5000;

const PRIVATE_IP_PATTERNS = [
  /^10\./, /^172\.(1[6-9]|2\d|3[0-1])\./, /^192\.168\./, /^127\./, /^0\./,
  /^169\.254\./, /^::1$/, /^fc00:/, /^fe80:/, /^fd/, /^localhost$/i,
];

function isPrivateHostname(hostname: string): boolean {
  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) return true;
  }
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith(`.${CONTAINER_DOMAIN}`) ||
    hostname.endsWith('.incus') ||
    hostname.endsWith('.test')
  );
}

function validateUrl(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return 'Invalid URL format'; }
  if (parsed.protocol !== 'https:') return 'Only HTTPS URLs are allowed';
  if (isPrivateHostname(parsed.hostname)) return 'URL targets a private/internal address';
  if (parsed.username || parsed.password) return 'URLs with credentials not allowed';
  return null;
}

export async function POST(request: NextRequest) {
  let body: { manifestUrl?: string; subdomain?: string; domain?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { manifestUrl, subdomain, domain } = body;

  if (!manifestUrl || !subdomain || !domain) {
    return new Response(
      JSON.stringify({ error: 'Missing required fields: manifestUrl, subdomain, domain' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Validate URL safety
  const urlError = validateUrl(manifestUrl);
  if (urlError) {
    return new Response(JSON.stringify({ error: urlError }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch and parse manifest
  let manifest;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(manifestUrl, {
      signal: controller.signal,
      headers: { 'Accept': 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-AppMarket/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch manifest: HTTP ${res.status}` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const yamlText = await res.text();
    if (yamlText.length > MAX_SIZE_BYTES) {
      return new Response(JSON.stringify({ error: 'Manifest exceeds 1MB size limit' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    const raw = parseYAML(yamlText, { maxAliasCount: 0 });
    const result = AppManifestSchema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`);
      return new Response(JSON.stringify({ error: 'Invalid manifest', details: errors }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    manifest = result.data;
  } catch (err) {
    return new Response(JSON.stringify({ error: `Manifest fetch failed: ${err}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Audit log
  console.log(`[Market] URL install started: ${manifestUrl} — app: ${manifest.metadata.id} v${manifest.version || 'unknown'} — subdomain: ${subdomain}.${domain}`);

  const appName = manifest.metadata?.name || manifest.metadata.id;
  const config: InstallConfig = {
    appId: manifest.metadata.id,
    subdomain,
    domain,
  };

  // Start tracking this install for reconnection support
  startTracking(config.appId, appName);

  // SSE stream installation progress
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const onEvent = (event: InstallEvent) => {
        trackEvent(config.appId, event);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch { /* Stream closed */ }
      };

      try {
        await installApp(manifest, config, onEvent);

        // After install, update metadata to track URL source
        try {
          const { updateInstalledAppSource } = await import('@/lib/market/installed-apps');
          await updateInstalledAppSource(manifest.metadata.id, 'url', manifestUrl);
        } catch {
          // Non-fatal — metadata tracking is optional
        }

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
        const errorMsg = String(err);
        finishTracking(config.appId, errorMsg);

        const errorEvent: InstallEvent = {
          step: 0, totalSteps: 0, status: 'error',
          message: 'Installation failed', detail: errorMsg,
        };
        trackEvent(config.appId, errorEvent);
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
        } catch { /* Stream closed */ }

        await sendNotificationToUI({
          title: `${appName} installation failed`,
          message: `Failed to install ${appName}: ${errorMsg}`,
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
