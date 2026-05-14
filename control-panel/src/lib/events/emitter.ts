/**
 * Platform Event Bus
 *
 * Central event emitter for YouEye platform events. When a significant
 * action happens (app installed, user login, settings changed, etc.),
 * the responsible code calls `emitEvent()`. The event bus delivers
 * events to app callbacks (manifest-declared capabilities.events).
 *
 * Events are fire-and-forget from the caller's perspective.
 * Delivery failures are logged but don't block the caller.
 */

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

// ─── App Event Delivery ─────────────────────────────────────

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
      const port = primarySpec?.port || 3000;

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
 * Delivers to app event callbacks.
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
      await deliverToApps(event);
    } catch (err) {
      console.error(`[EventBus] Event delivery failed for ${type}:`, err);
    }
  })();
}
