/**
 * Suggestions Engine
 *
 * Scans app `wants` declarations against installed apps to generate
 * connection suggestions. Internet access is NAT on/off (`internet:`), so there are no
 * per-host internet suggestions; `proxy:` scopes are granted per user in the dashboard.
 */

import { readFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { listReadableInstalledApps } from '../market/metadata';
import { readInstalledAppManifest } from '../market/frozen-manifest';
import { sendNotificationToUI } from '../health/notification-bridge';
import { loadBridges } from './store';
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

/**
 * One writer at a time. Every change of the store reads it, edits the list and writes it back; two of those at
 * once (an install's suggestions, the cleanup at start, a dismissal) each wrote their own copy and the later one
 * undid the earlier. The queue is kept on `globalThis`: the instrumentation hook and the routes are separate
 * bundles of this module in one process.
 */
const STORE_QUEUE = Symbol.for('youeye.suggestion-store-queue');
function withSuggestionStore<T>(work: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as Record<symbol, Promise<unknown> | undefined>;
  const run = (holder[STORE_QUEUE] ?? Promise.resolve()).then(work, work);
  holder[STORE_QUEUE] = run.catch(() => undefined);
  return run;
}

export async function listSuggestions(includesDismissed = false): Promise<Suggestion[]> {
  const suggestions = await readStore();
  if (includesDismissed) return suggestions;
  return suggestions.filter(s => !s.dismissed);
}

export function dismissSuggestion(id: string): Promise<void> {
  return withSuggestionStore(async () => {
    const suggestions = await readStore();
    const s = suggestions.find(s => s.id === id);
    if (s) {
      s.dismissed = true;
      await writeStore(suggestions);
    }
  });
}

export function removeSuggestion(id: string): Promise<void> {
  return withSuggestionStore(async () => {
    const suggestions = await readStore();
    const filtered = suggestions.filter(s => s.id !== id);
    await writeStore(filtered);
  });
}

/**
 * An admin disconnected `from` → `target` (Settings → Apps → Connections, YE-227): the approval removed its
 * suggestion, and suggestions are otherwise made only at an install or an update, so it comes back here, waiting for
 * a new approval, while the consumer still asks for the target and both are installed. No notification: the admin
 * has just chosen this. Returns whether a suggestion is waiting now.
 */
export function suggestAgainAfterDisconnect(fromAppId: string, targetAppId: string): Promise<boolean> {
  return withSuggestionStore(async () => {
    const installed = await listReadableInstalledApps();
    const consumer = installed.find((m) => m.appId === fromAppId);
    const target = installed.find((m) => m.appId === targetAppId);
    if (!consumer || !target) return false;
    if ((await loadBridges()).some((b) => b.from === fromAppId && b.to === targetAppId)) return false;
    const targetProvides = await installedProvides(target);
    const want = (await installedWants(consumer)).find((w) => wantResolvesToApp(w, targetAppId, targetProvides));
    if (!want) return false;
    const nameOf = (appId: string) => readInstalledAppManifest(appId).then((m) => m.metadata.name || appId, () => appId);
    const suggestions = await readStore();
    const prior = suggestions.find((s) => s.type === 'bridge' && s.fromAppId === fromAppId && s.targetAppId === targetAppId);
    if (prior) {
      if (!prior.dismissed && prior.targetInstalled !== false) return true;
      prior.dismissed = false;
      prior.targetInstalled = true;
    } else {
      suggestions.push({
        id: `bridge-${fromAppId}-${targetAppId}`,
        type: 'bridge',
        fromAppId,
        fromAppName: await nameOf(fromAppId),
        targetAppId,
        targetAppName: await nameOf(targetAppId),
        targetInstalled: true,
        scope: want.scope ?? 'user',
        dismissed: false,
        createdAt: new Date().toISOString(),
      });
    }
    await writeStore(suggestions);
    return true;
  });
}

/**
 * Forget an uninstalled app: drop the suggestions it made, and mark suggestions that point at it
 * as waiting for their target again.
 */
export function forgetSuggestionsForApp(appId: string): Promise<void> {
  return withSuggestionStore(async () => {
    const suggestions = await readStore();
    const kept = suggestions.filter((s) => s.fromAppId !== appId);
    let changed = kept.length !== suggestions.length;
    for (const s of kept) {
      if (s.targetAppId === appId && s.targetInstalled !== false) {
        s.targetInstalled = false;
        changed = true;
      }
    }
    if (changed) await writeStore(kept);
  });
}

/**
 * Generate suggestions for a newly installed app.
 * Scans its `wants` list against installed apps.
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

/**
 * Read an installed app's declared `wants`: from its frozen copy (what is installed now), else from the install
 * metadata. The metadata of an app updated before 0.6.15 still names what the release it was installed from wanted.
 */
async function installedWants(meta: InstallMetadata): Promise<WantSpec[]> {
  try {
    const m = await readInstalledAppManifest(meta.appId);
    return m.wants ?? [];
  } catch {
    return meta.wants ?? [];
  }
}

/**
 * What an installed app provides: from its frozen copy (what is installed now), else from the install metadata,
 * like `installedWants`. The metadata of an app updated before 0.6.15 still names what the release it was
 * installed from provided.
 */
async function installedProvides(meta: InstallMetadata): Promise<ProvidesSpec[]> {
  try {
    const m = await readInstalledAppManifest(meta.appId);
    return m.provides ?? [];
  } catch {
    return meta.provides ?? [];
  }
}

/** `installedProvides` of every installed app, by app ID. */
async function installedProvidesByApp(installed: InstallMetadata[]): Promise<Map<string, ProvidesSpec[]>> {
  const provides = new Map<string, ProvidesSpec[]>();
  for (const meta of installed) provides.set(meta.appId, await installedProvides(meta));
  return provides;
}

/**
 * The stored suggestions without those an app no longer asks for: suggestions made by `appId` whose target none
 * of its current `wants` resolves to. Suggestions of other apps, and approved connections, are not touched.
 * `providesOf` answers `null` for a target whose `provides` cannot be told: a suggestion made for a wanted
 * capability then stays (nothing says the target stopped providing it).
 */
export function withoutDroppedWants(
  suggestions: Suggestion[],
  appId: string,
  wants: WantSpec[],
  providesOf: (targetAppId: string) => ProvidesSpec[] | null | undefined,
): Suggestion[] {
  return suggestions.filter((s) => {
    if (s.type !== 'bridge' || s.fromAppId !== appId || !s.targetAppId) return true;
    const target = s.targetAppId;
    const provides = providesOf(target);
    return wants.some((want) => (provides === null && !want.appId && want.type ? true : wantResolvesToApp(want, target, provides ?? undefined)));
  });
}

/**
 * After an app update: its new release may want other apps than the installed one did. Drop the suggestions it
 * no longer asks for (Translate 0.6.5 dropped LibreTranslate and kept "waiting for libretranslate" for ever), then
 * add the ones it asks for now.
 */
export async function refreshSuggestionsForUpdatedApp(manifest: AppManifest): Promise<void> {
  const actionable = await withSuggestionStore(async () => {
    const existing = await readStore();
    const provides = await installedProvidesByApp(await listReadableInstalledApps());
    const kept = withoutDroppedWants(existing, manifest.metadata.id, manifest.wants ?? [], (id) => provides.get(id));
    if (kept.length !== existing.length) await writeStore(kept);
    return (await generateSuggestionsInStore(manifest)).actionable;
  });
  await notifyNewConnections(actionable);
}

/**
 * At Control Panel start: drop the suggestions installed apps no longer ask for. An app updated by a Control Panel
 * before 0.6.15 kept the suggestions of the release it was installed from. An app whose installed copy cannot be
 * read keeps its suggestions. Returns how many were dropped.
 *
 * What a target provides is read from its installed copy too, never from its install metadata: that still names
 * what the release it was installed from provided, and a suggestion for a capability the target has gained since
 * was dropped by mistake. A target whose installed copy cannot be read keeps the suggestions made for a capability.
 */
export function dropSuggestionsOfDroppedWants(): Promise<number> {
  return withSuggestionStore(async () => {
    const existing = await readStore();
    if (existing.length === 0) return 0;
    const installed = await listReadableInstalledApps();
    const provides = new Map<string, ProvidesSpec[] | null>();
    const providesOf = (id: string) => provides.get(id);
    let kept = existing;
    for (const meta of installed) {
      if (!kept.some((s) => s.fromAppId === meta.appId)) continue;
      let wants: WantSpec[];
      try {
        wants = (await readInstalledAppManifest(meta.appId)).wants ?? [];
      } catch {
        continue;
      }
      for (const s of kept) {
        const target = s.targetAppId;
        if (s.fromAppId !== meta.appId || !target || provides.has(target) || !installed.some((m) => m.appId === target)) continue;
        provides.set(target, await readInstalledAppManifest(target).then((m) => m.provides ?? [], () => null));
      }
      kept = withoutDroppedWants(kept, meta.appId, wants, providesOf);
    }
    if (kept.length === existing.length) return 0;
    await writeStore(kept);
    return existing.length - kept.length;
  });
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
 *  2. Reverse — every OTHER installed app whose `wants` resolve to THIS newly installed app
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
  const { created, actionable } = await withSuggestionStore(() => generateSuggestionsInStore(manifest, skipTargetIds));
  // Heads-up notification for connections that can be approved right now (outside the store's queue: it waits
  // for the dashboard).
  await notifyNewConnections(actionable);
  return created;
}

/** `generateSuggestionsForApp` without the queue and the notification, for callers that hold the queue. */
async function generateSuggestionsInStore(
  manifest: AppManifest,
  skipTargetIds?: Set<string>,
): Promise<{ created: Suggestion[]; actionable: Suggestion[] }> {
  const existing = await readStore();
  const bridges = await loadBridges();
  const installedMetas = await listReadableInstalledApps();
  const providesByApp = await installedProvidesByApp(installedMetas);

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
        if (!(providesByApp.get(provider.appId) ?? []).some((p) => p.type === want.type)) continue;
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

  // 2. Reverse — other installed apps that want THIS newly installed app.
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

  return { created: newSuggestions, actionable };
}
