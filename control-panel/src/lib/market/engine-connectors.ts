/**
 * Connector resolution for the app install engine.
 *
 * Resolves connector requirements declared in app manifests by looking up
 * the connector registry (YE-AppMarket/connectors/*.yaml) and checking
 * whether the providing app is actually installed (via install.json).
 *
 * Uses `compatibleApps` from connector manifests to discover which installed
 * apps can back each connector — no hardcoded maps.
 */

import { CONTAINER_DOMAIN } from './constants';
import { readInstallMetadata } from './metadata';
import { findConnectorByCapability, fetchConnectorManifest } from '../connectors/registry';
import type { AppManifest } from './types';

/**
 * Given a connector manifest, find an installed app that backs it
 * using the connector's `compatibleApps` metadata.
 * Returns the internal URL if a compatible app is installed.
 */
async function resolveConnectorUrl(
  connectorId: string,
): Promise<{ url: string; type: string } | null> {
  let manifest;
  try {
    manifest = await fetchConnectorManifest(connectorId);
  } catch {
    return null;
  }

  // External-only connectors don't need an installed app
  if (manifest.metadata.source === 'external') return null;

  const compatibleApps = manifest.metadata.compatibleApps;
  if (!compatibleApps?.length) return null;

  // Check each compatible app to see if it's installed
  for (const compat of compatibleApps) {
    const meta = await readInstallMetadata(compat.appId);
    if (!meta) continue;

    // Find the primary container name from install metadata
    const containers = meta.containers ?? [];
    let primaryName: string | null = null;

    if (containers.length > 0) {
      const first = containers[0];
      if (typeof first === 'string') {
        // v1 format: string array
        primaryName = (containers as unknown as string[]).find((c) => c.includes('main')) ?? (containers[0] as unknown as string);
      } else {
        // v2 format: object array
        const objs = containers as Array<{ name: string; containerName: string; type: string }>;
        primaryName = (objs.find((c) => c.name === 'main') ?? objs[0])?.containerName ?? null;
      }
    }
    if (!primaryName) continue;

    const url = `${compat.protocol}://${primaryName}.${CONTAINER_DOMAIN}:${compat.defaultPort}`;
    return { url, type: compat.appId };
  }

  return null;
}

/** Map capability names to env var prefixes for injection */
const CAPABILITY_ENV_MAP: Record<string, { urlKey: string; typeKey: string }> = {
  'search-engine': { urlKey: 'SEARCH_ENGINE_URL', typeKey: 'SEARCH_ENGINE_TYPE' },
  'translation': { urlKey: 'TRANSLATION_URL', typeKey: 'TRANSLATION_TYPE' },
  'weather-data': { urlKey: 'WEATHER_DATA_URL', typeKey: 'WEATHER_DATA_TYPE' },
  'media-catalog': { urlKey: 'MEDIA_CATALOG_URL', typeKey: 'MEDIA_CATALOG_TYPE' },
  'music-search': { urlKey: 'MUSIC_URL', typeKey: 'MUSIC_TYPE' },
  'photo-browse': { urlKey: 'PHOTOS_URL', typeKey: 'PHOTOS_TYPE' },
};

/**
 * Resolve connector requirements from a manifest into extra environment variables.
 * Returns a record of env vars to inject into the app container.
 */
export async function resolveConnectors(
  manifest: AppManifest,
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  for (const req of manifest.connectors?.requires ?? []) {
    // Find a connector that provides this capability
    const connector = await findConnectorByCapability(req.capability);
    if (!connector) continue;

    const resolved = await resolveConnectorUrl(connector.metadata.id);
    if (!resolved) continue;

    // Use capability-specific env var names, or generic fallback
    const mapping = CAPABILITY_ENV_MAP[req.capability];
    if (mapping) {
      env[mapping.urlKey] = resolved.url;
      env[mapping.typeKey] = resolved.type;
    } else {
      // Generic: CONNECTOR_{CAPABILITY}_URL
      const envPrefix = req.capability.toUpperCase().replace(/-/g, '_');
      env[`CONNECTOR_${envPrefix}_URL`] = resolved.url;
      env[`CONNECTOR_${envPrefix}_TYPE`] = resolved.type;
    }
  }

  return env;
}
