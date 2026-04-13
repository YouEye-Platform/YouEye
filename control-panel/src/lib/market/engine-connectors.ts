/**
 * Connector resolution for the app install engine.
 * Resolves connector requirements declared in app manifests by checking
 * what's already installed on the platform.
 *
 * Example: Search app declares `connectors.requires: [{ capability: "search-engine" }]`.
 * This module detects if Whoogle or SearXNG is installed and provides the URL.
 */

import { getAllInstalledApps } from './installed-apps';
import { readInstallMetadata } from './metadata';
import { containerExists } from '../infrastructure/oci-deployer';
import type { AppManifest } from './types';

interface DetectedSearchEngine {
  type: 'whoogle' | 'searxng';
  containerName: string;
  port: number;
  url: string;
}

/**
 * Detect an installed search engine (Whoogle or SearXNG).
 * Checks installed_apps DB, install.json metadata, and Incus containers.
 */
async function detectSearchEngine(): Promise<DetectedSearchEngine | null> {
  // Check installed_apps DB table first
  try {
    const installedApps = await getAllInstalledApps();
    for (const app of installedApps) {
      if (app.appId === 'whoogle') {
        return { type: 'whoogle', containerName: 'app-whoogle', port: 5000, url: 'http://app-whoogle.incus:5000' };
      }
      if (app.appId === 'searxng') {
        return { type: 'searxng', containerName: 'app-searxng', port: 8080, url: 'http://app-searxng.incus:8080' };
      }
    }
  } catch {
    // DB not available — fall through
  }

  // Check install.json metadata as fallback
  const whoogleMeta = await readInstallMetadata('whoogle');
  if (whoogleMeta) {
    const cn = whoogleMeta.containers?.[0] ?? 'app-whoogle';
    return { type: 'whoogle', containerName: cn, port: 5000, url: `http://${cn}.incus:5000` };
  }

  const searxngMeta = await readInstallMetadata('searxng');
  if (searxngMeta) {
    const cn = searxngMeta.containers?.[0] ?? 'app-searxng';
    return { type: 'searxng', containerName: cn, port: 8080, url: `http://${cn}.incus:8080` };
  }

  // Last resort: probe Incus directly
  for (const name of ['app-whoogle', 'app-whoogle-main']) {
    if (await containerExists(name)) {
      return { type: 'whoogle', containerName: name, port: 5000, url: `http://${name}.incus:5000` };
    }
  }
  for (const name of ['app-searxng', 'app-searxng-main']) {
    if (await containerExists(name)) {
      return { type: 'searxng', containerName: name, port: 8080, url: `http://${name}.incus:8080` };
    }
  }

  return null;
}

/**
 * Resolve connector requirements from a manifest into extra environment variables.
 * Returns a record of env vars to inject into the app container.
 */
export async function resolveConnectors(
  manifest: AppManifest,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const req of manifest.connectors?.requires ?? []) {
    if (req.capability === 'search-engine') {
      const engine = await detectSearchEngine();
      if (engine) {
        env.SEARCH_ENGINE_URL = engine.url;
        env.SEARCH_ENGINE_TYPE = engine.type;
      }
    }
  }

  return env;
}
