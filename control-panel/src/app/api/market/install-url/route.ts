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
import { parse as parseYAML } from 'yaml';
import { AppManifestSchema } from '@/lib/market/schema';
import { installApp } from '@/lib/market/engine';
import { CONTAINER_DOMAIN } from '@/lib/market/constants';
import { finishTracking, sanitiseInstallEvent, sensitivitySafeInstallError, startTracking, trackEvent } from '@/lib/market/install-tracker';
import { sendNotificationToUI } from '@/lib/health/notification-bridge';
import { settingsService } from '@/lib/settings';
import { requireAdmin } from '@/lib/auth/rbac';
import type { InstallConfig, InstallEvent } from '@/lib/market/types';
import { saveDirectMarketApp } from '@/lib/market/direct-apps';

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

  let body: { manifestUrl?: string; url?: string; subdomain?: string; domain?: string; acceptUnverifiedPublisher?: boolean };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
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
  const urlError = validateUrl(manifestUrl);
  if (urlError) {
    return new Response(JSON.stringify({ error: urlError }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Fetch and parse manifest
  let manifest;
  let yamlText = '';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(manifestUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { 'Accept': 'text/yaml, application/yaml, text/plain, */*', 'User-Agent': 'YouEye-Market/1.0' },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Failed to fetch manifest: HTTP ${res.status}` }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    if (res.headers.get('content-type')?.toLowerCase().includes('text/html')) {
      return new Response(JSON.stringify({ error: 'Manifest URL returned an HTML document' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }
    const contentLength = Number(res.headers.get('content-length') || '0');
    if (contentLength > MAX_SIZE_BYTES) {
      return new Response(JSON.stringify({ error: 'Manifest exceeds 1MB size limit' }), {
        status: 400, headers: { 'Content-Type': 'application/json' },
      });
    }

    yamlText = await res.text();
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
  } catch {
    return new Response(JSON.stringify({ error: 'Manifest fetch or verification failed' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
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
  const directEntry = await saveDirectMarketApp({ manifestUrl, manifestText: yamlText, manifest });
  const config: InstallConfig = {
    appId: manifest.metadata.id,
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
  try {
    startTracking(config.appId, appName);
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
        await installApp(manifest, config, onEvent);
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
        const errorMsg = sensitivitySafeInstallError(err);
        if (baseInstallComplete) {
          const { uninstallApp } = await import('@/lib/market/uninstaller');
          const rollback = await uninstallApp(config.appId, {
            keepData: false,
            dropSharedDatabase: true,
          }).catch(() => null);
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
