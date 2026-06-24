/**
 * Suggestions Engine
 *
 * Scans app `wants` declarations against installed apps to generate
 * connection suggestions. Also generates internet access suggestions
 * from `internet.hosts` declarations.
 */

import { readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { listInstalledApps } from '../market/metadata';
import { fetchManifest } from '../market/catalog';
import { sendNotificationToUI } from '../health/notification-bridge';
import { loadBridges } from './store';
import { listInternetGrants } from './internet-store';
import { writeJsonAtomically } from './atomic-json-store';
import type { AppManifest, InstallMetadata, ProvidesSpec, WantSpec } from '../market/types';

const STORE_DIR = '/var/lib/youeye/bridges';
const STORE_FILE = join(STORE_DIR, 'suggestions.json');

export interface Suggestion {
  id: string;
  type: 'bridge' | 'internet';
  fromAppId: string;
  fromAppName: string;
  /** For bridge: target app ID. For internet: null */
  targetAppId?: string;
  targetAppName?: string;
  /** For internet: hosts requested */
  hosts?: string[];
  /** Whether the target app is installed */
  targetInstalled?: boolean;
  /**
   * Connection scope for routing the grant (from the consumer's `want.scope`):
   * `user` = each user grants individually; `service` = one server-wide (owner) grant.
   */
  scope?: 'user' | 'service';
  dismissed: boolean;
  createdAt: string;
}

async function readStore(): Promise<Suggestion[]> {
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeStore(suggestions: Suggestion[]): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  await writeJsonAtomically(STORE_FILE, suggestions);
}

export async function listSuggestions(includesDismissed = false): Promise<Suggestion[]> {
  const suggestions = await readStore();
  if (includesDismissed) return suggestions;
  return suggestions.filter(s => !s.dismissed);
}

export async function dismissSuggestion(id: string): Promise<void> {
  const suggestions = await readStore();
  const s = suggestions.find(s => s.id === id);
  if (s) {
    s.dismissed = true;
    await writeStore(suggestions);
  }
}

export async function removeSuggestion(id: string): Promise<void> {
  const suggestions = await readStore();
  const filtered = suggestions.filter(s => s.id !== id);
  await writeStore(filtered);
}

/**
 * Generate suggestions for a newly installed app.
 * Scans its `wants` list against installed apps, and its `internet.hosts`.
 * Also checks all OTHER installed apps' `wants` to see if any want this new app.
 *
 * @param skipTargetIds - target app IDs to skip (already approved at install time)
 */
/** Does a consumer's `want` resolve to a given provider app — by explicit appId,
 *  or by capability type matching one of the provider's `provides` entries? */
function wantResolvesToApp(
  want: WantSpec,
  targetAppId: string,
  targetProvides: ProvidesSpec[] | undefined,
): boolean {
  if (want.appId) return want.appId === targetAppId;
  if (want.type) return (targetProvides ?? []).some((p) => p.type === want.type);
  return false;
}

/** Read an installed app's declared `wants`. Prefers the value persisted in install
 *  metadata; for apps installed before `wants` were persisted, falls back to a (cached)
 *  manifest fetch so the reverse-scan still works during the transition. */
async function installedWants(meta: InstallMetadata): Promise<WantSpec[]> {
  if (meta.wants) return meta.wants;
  try {
    const m = await fetchManifest(meta.appId);
    return m.wants ?? [];
  } catch {
    return [];
  }
}

/** Notify the owner/admins that new app connections are available. Per-user discovery
 *  (including users who join later) is handled by the always-on Connections panel count;
 *  this push is the proactive heads-up for whoever manages installs. Non-fatal — a UI that
 *  is unreachable must not break suggestion generation, but the failure is logged. */
async function notifyNewConnections(newBridges: Suggestion[]): Promise<void> {
  if (newBridges.length === 0) return;
  const lines = newBridges.map(
    (s) => `${s.fromAppName} → ${s.targetAppName}${s.scope === 'service' ? ' (server-wide)' : ''}`,
  );
  try {
    await sendNotificationToUI({
      title:
        newBridges.length === 1
          ? 'New app connection available'
          : `${newBridges.length} new app connections available`,
      message: `${lines.join(', ')}. Review each app's Connections panel to approve.`,
      type: 'info',
      source: 'system',
      userId: null, // owner/admins
    });
  } catch (err) {
    console.error('[suggestions] Failed to push connection notification:', err);
  }
}

/**
 * Generate connection suggestions when an app is installed.
 *
 * Three passes, all `scope`-aware:
 *  1. Forward — this app's `wants` (appId-based → the named target; type-based → every
 *     installed app whose `provides` matches the wanted capability type).
 *  2. Internet — this app's `internet.hosts`.
 *  3. Reverse — every OTHER installed app whose `wants` resolve to THIS newly installed app
 *     (so installing a provider lights up the pending-connection count for existing consumers).
 *
 * Then pushes one heads-up notification covering the connections that can be approved now
 * (target installed) — whether created this pass or flipped to approvable by the reverse-scan.
 *
 * @param skipTargetIds - target app IDs to skip (already approved at install time)
 */
export async function generateSuggestionsForApp(
  manifest: AppManifest,
  skipTargetIds?: Set<string>,
): Promise<Suggestion[]> {
  const existing = await readStore();
  const bridges = await loadBridges();
  const internetGrants = await listInternetGrants();
  const installedMetas = await listInstalledApps();

  const newSuggestions: Suggestion[] = [];
  // Bridge suggestions whose target is installed and can therefore be approved right now —
  // either created fresh this pass, or flipped from "pending, target not installed" by the
  // reverse-scan. These (not the not-yet-actionable ones) drive the heads-up notification.
  const actionable: Suggestion[] = [];
  let storeChanged = false;
  const appId = manifest.metadata.id;
  const appName = manifest.metadata.name;
  const isInstalled = (id: string) => installedMetas.some((m) => m.appId === id);
  const hasBridge = (from: string, to: string) => bridges.some((b) => b.from === from && b.to === to);

  /** Create a from→to bridge suggestion, or refresh an existing one's installed/scope state.
   *  Returns the suggestion only when it is newly created. */
  const upsertBridgeSuggestion = (args: {
    fromAppId: string;
    fromAppName: string;
    targetAppId: string;
    targetAppName: string;
    scope: 'user' | 'service';
    targetInstalled: boolean;
  }): void => {
    const { fromAppId, fromAppName, targetAppId, targetAppName, scope, targetInstalled } = args;
    if (hasBridge(fromAppId, targetAppId)) return; // already connected
    const prior = existing.find(
      (s) => s.type === 'bridge' && s.fromAppId === fromAppId && s.targetAppId === targetAppId,
    );
    if (prior) {
      // The target may have just become installed, or its scope may have changed — refresh.
      let changed = false;
      if (targetInstalled && prior.targetInstalled === false) {
        prior.targetInstalled = true;
        changed = true;
        actionable.push(prior); // pending connection just became approvable
      }
      if (prior.scope !== scope) { prior.scope = scope; changed = true; }
      if (changed) storeChanged = true;
      return;
    }
    const created: Suggestion = {
      id: `bridge-${fromAppId}-${targetAppId}`,
      type: 'bridge',
      fromAppId,
      fromAppName,
      targetAppId,
      targetAppName,
      targetInstalled,
      scope,
      dismissed: false,
      createdAt: new Date().toISOString(),
    };
    newSuggestions.push(created);
    if (targetInstalled) actionable.push(created);
  };

  // 1. Forward — this app's wants
  const wants = manifest.wants ?? [];
  for (const want of wants) {
    const scope = want.scope ?? 'user';
    if (want.appId) {
      if (skipTargetIds?.has(want.appId)) continue;
      upsertBridgeSuggestion({
        fromAppId: appId,
        fromAppName: appName,
        targetAppId: want.appId,
        targetAppName: want.name,
        scope,
        targetInstalled: isInstalled(want.appId),
      });
    } else if (want.type) {
      // Type-based: suggest every installed app that provides this capability type.
      for (const provider of installedMetas) {
        if (provider.appId === appId) continue;
        if (!(provider.provides ?? []).some((p) => p.type === want.type)) continue;
        if (skipTargetIds?.has(provider.appId)) continue;
        upsertBridgeSuggestion({
          fromAppId: appId,
          fromAppName: appName,
          targetAppId: provider.appId,
          targetAppName: want.name,
          scope,
          targetInstalled: true,
        });
      }
    }
  }

  // 2. This app's internet.hosts
  const internetHosts = manifest.internet?.hosts ?? [];
  if (internetHosts.length > 0) {
    const existingGrant = internetGrants.find((g) => g.appId === appId);
    if (!existingGrant) {
      const existingSuggestion = existing.find((s) => s.fromAppId === appId && s.type === 'internet');
      if (!existingSuggestion) {
        newSuggestions.push({
          id: `internet-${appId}`,
          type: 'internet',
          fromAppId: appId,
          fromAppName: appName,
          hosts: internetHosts,
          dismissed: false,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // 3. Reverse — other installed apps that want THIS newly installed app.
  for (const consumer of installedMetas) {
    if (consumer.appId === appId) continue;
    const consumerWants = await installedWants(consumer);
    for (const want of consumerWants) {
      if (!wantResolvesToApp(want, appId, manifest.provides)) continue;
      upsertBridgeSuggestion({
        fromAppId: consumer.appId,
        // install metadata does not persist the display name; appId is the stable label
        fromAppName: consumer.appId,
        targetAppId: appId,
        targetAppName: appName,
        scope: want.scope ?? 'user',
        targetInstalled: true,
      });
    }
  }

  if (newSuggestions.length > 0 || storeChanged) {
    await writeStore([...existing, ...newSuggestions]);
  }

  // 4. Heads-up notification for connections that can be approved right now.
  await notifyNewConnections(actionable);

  return newSuggestions;
}
