/**
 * Platform Event Bus
 *
 * Central event emitter for YouEye platform events. When a significant
 * action happens (app installed, user login, settings changed, etc.),
 * the responsible code calls `emitEvent()`. The event bus then:
 *
 *   1. Delivers to registered webhook URLs (admin-configured)
 *   2. Delivers to app event callbacks (manifest-declared capabilities.events)
 *
 * Events are fire-and-forget from the caller's perspective.
 * Delivery failures are logged but don't block the caller.
 */

import { createHmac } from 'crypto';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { listInstalledApps } from '@/lib/market/metadata';
import { fetchManifest } from '@/lib/market/catalog';
import { getContainerIP } from '@/lib/incus/container-ip';

// ─── Types ────────────────────────────────────────────────

export type PlatformEventType =
  | 'app.installed'
  | 'app.uninstalled'
  | 'app.updated'
  | 'user.created'
  | 'user.login'
  | 'settings.changed'
  | 'backup.completed'
  | 'backup.failed'
  | 'system.health.changed';

export interface PlatformEvent {
  event: PlatformEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface WebhookConfig {
  id: string;
  url: string;
  secret: string;
  events: PlatformEventType[];
  enabled: boolean;
  createdAt: string;
  description?: string;
}

interface WebhookStore {
  webhooks: WebhookConfig[];
}

// ─── Webhook Persistence ──────────────────────────────────

const WEBHOOK_CONFIG_PATH = '/var/lib/youeye/control/webhooks.json';

async function loadWebhooks(): Promise<WebhookConfig[]> {
  try {
    const data = await readFile(WEBHOOK_CONFIG_PATH, 'utf-8');
    const store: WebhookStore = JSON.parse(data);
    return store.webhooks || [];
  } catch {
    return [];
  }
}

async function saveWebhooks(webhooks: WebhookConfig[]): Promise<void> {
  const dir = '/var/lib/youeye/control';
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  await writeFile(
    WEBHOOK_CONFIG_PATH,
    JSON.stringify({ webhooks }, null, 2),
    { mode: 0o600 }
  );
}

// ─── Webhook CRUD ────────────────────────────���────────────

export async function listWebhooks(): Promise<WebhookConfig[]> {
  return loadWebhooks();
}

export async function createWebhook(
  config: Omit<WebhookConfig, 'id' | 'createdAt' | 'secret'>
): Promise<WebhookConfig> {
  const webhooks = await loadWebhooks();

  // Generate webhook secret for HMAC signatures
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = Array.from(secretBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const webhook: WebhookConfig = {
    id: crypto.randomUUID(),
    secret,
    createdAt: new Date().toISOString(),
    ...config,
  };

  webhooks.push(webhook);
  await saveWebhooks(webhooks);
  return webhook;
}

export async function updateWebhook(
  id: string,
  updates: Partial<Pick<WebhookConfig, 'url' | 'events' | 'enabled' | 'description'>>
): Promise<WebhookConfig | null> {
  const webhooks = await loadWebhooks();
  const idx = webhooks.findIndex((w) => w.id === id);
  if (idx === -1) return null;

  webhooks[idx] = { ...webhooks[idx], ...updates };
  await saveWebhooks(webhooks);
  return webhooks[idx];
}

export async function deleteWebhook(id: string): Promise<boolean> {
  const webhooks = await loadWebhooks();
  const filtered = webhooks.filter((w) => w.id !== id);
  if (filtered.length === webhooks.length) return false;
  await saveWebhooks(filtered);
  return true;
}

// ─── HMAC Signing ─────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// ─── Delivery ─────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_DELAYS = [1000, 5000, 15000]; // 1s, 5s, 15s

async function deliverToWebhook(
  webhook: WebhookConfig,
  event: PlatformEvent
): Promise<void> {
  const payload = JSON.stringify(event);
  const signature = signPayload(payload, webhook.secret);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouEye-Signature': `sha256=${signature}`,
          'X-YouEye-Event': event.event,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok || res.status < 500) return; // Success or client error (don't retry)
      // Server error — retry
    } catch {
      // Network error — retry
    }

    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }

  console.error(
    `[EventBus] Webhook delivery failed after ${MAX_RETRIES + 1} attempts: ${webhook.url} event=${event.event}`
  );
}

async function deliverToApps(event: PlatformEvent): Promise<void> {
  const installedApps = await listInstalledApps();

  for (const app of installedApps) {
    try {
      const manifest = await fetchManifest(app.appId);
      const subscribedEvents = manifest?.capabilities?.events;
      if (!subscribedEvents || !subscribedEvents.includes(event.event)) continue;

      // Find the primary container's IP
      const firstContainer = app.containers?.[0];
      if (!firstContainer) continue;
      const primaryContainer = typeof firstContainer === 'string' ? firstContainer : (firstContainer as any).containerName;

      const ip = await getContainerIP(primaryContainer);
      if (!ip) continue;

      // Derive port from manifest
      const primarySpec = manifest?.containers?.find((c) => c.primary) || manifest?.containers?.[0];
      const port = primarySpec?.port || (manifest?.native?.port) || 3000;

      const payload = JSON.stringify(event);

      await fetch(`http://${ip}:${port}/api/youeye/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouEye-Event': event.event,
          'X-YouEye-App': 'platform',
        },
        body: payload,
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {
        // Best-effort — app may not implement the endpoint
      });
    } catch {
      // Skip apps that can't receive events
    }
  }
}

// ─── Main Emitter ─────────────────────────────────────────

/**
 * Emit a platform event.
 * Delivers to all matching webhook URLs and app callbacks.
 * Non-blocking — fires and forgets. Errors are logged, not thrown.
 */
export function emitEvent(
  type: PlatformEventType,
  data: Record<string, unknown> = {}
): void {
  const event: PlatformEvent = {
    event: type,
    timestamp: new Date().toISOString(),
    data,
  };

  // Fire-and-forget delivery
  (async () => {
    try {
      // Deliver to webhooks
      const webhooks = await loadWebhooks();
      const matching = webhooks.filter(
        (w) => w.enabled && w.events.includes(type)
      );

      await Promise.allSettled(
        matching.map((w) => deliverToWebhook(w, event))
      );

      // Deliver to apps
      await deliverToApps(event);
    } catch (err) {
      console.error(`[EventBus] Event delivery failed for ${type}:`, err);
    }
  })();
}
