/**
 * Suggestions Engine
 *
 * Scans app `wants` declarations against installed apps to generate
 * connection suggestions. Also generates internet access suggestions
 * from `internet.hosts` declarations.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getAllInstalledApps } from '../market/installed-apps';
import { loadBridges } from './store';
import { listInternetGrants } from './internet-store';
import type { AppManifest } from '../market/types';

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
  await writeFile(STORE_FILE, JSON.stringify(suggestions, null, 2));
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
export async function generateSuggestionsForApp(
  manifest: AppManifest,
  skipTargetIds?: Set<string>,
): Promise<Suggestion[]> {
  const existing = await readStore();
  const bridges = await loadBridges();
  const internetGrants = await listInternetGrants();
  const installedApps = await getAllInstalledApps();

  const newSuggestions: Suggestion[] = [];
  const appId = manifest.metadata.id;
  const appName = manifest.metadata.name;

  // 1. Check this app's wants against installed apps
  //    Only appId-based wants generate suggestions; type-based wants are
  //    resolved dynamically via the providers endpoint.
  const wants = manifest.wants ?? [];
  for (const want of wants) {
    if (!want.appId) continue; // Type-based wants don't generate suggestions
    // Skip targets already approved at install time
    if (skipTargetIds?.has(want.appId)) continue;

    const existing_bridge = bridges.find(
      b => b.from === appId && b.to === want.appId
    );
    if (existing_bridge) continue; // Already bridged

    const existingSuggestion = existing.find(
      s => s.fromAppId === appId && s.targetAppId === want.appId
    );
    if (existingSuggestion) continue; // Already suggested

    const targetInstalled = installedApps.some(a => a.appId === want.appId);

    newSuggestions.push({
      id: `bridge-${appId}-${want.appId}`,
      type: 'bridge',
      fromAppId: appId,
      fromAppName: appName,
      targetAppId: want.appId,
      targetAppName: want.name,
      targetInstalled,
      dismissed: false,
      createdAt: new Date().toISOString(),
    });
  }

  // 2. Check this app's internet.hosts
  const internetHosts = manifest.internet?.hosts ?? [];
  if (internetHosts.length > 0) {
    const existingGrant = internetGrants.find(g => g.appId === appId);
    if (!existingGrant) {
      const existingSuggestion = existing.find(
        s => s.fromAppId === appId && s.type === 'internet'
      );
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

  // Note: reverse-check (do other installed apps want this new app?) is deferred
  // because installed-apps store doesn't persist manifests at runtime.
  // Forward wants + internet suggestions cover the primary use case.

  if (newSuggestions.length > 0) {
    const updated = [...existing, ...newSuggestions];
    await writeStore(updated);
  }

  return newSuggestions;
}
