/**
 * Connector resolution for the app install engine.
 *
 * Resolves connector requirements declared in app manifests by looking up
 * the connector registry (YE-AppMarket/connectors/*.yaml) and checking
 * whether the providing app is actually installed (via install.json).
 *
 * This is generic — adding a new connector only requires a YAML manifest
 * in YE-AppMarket and an install.json for the providing app. No code
 * changes needed here.
 */

import { CONTAINER_DOMAIN } from './constants';
import { readInstallMetadata } from './metadata';
import { findConnectorByCapability, fetchConnectorManifest } from '../connectors/registry';
import type { AppManifest } from './types';

/** Map from connector metadata.id prefix to the appId in installed_apps */
const CONNECTOR_APP_MAP: Record<string, string> = {
  'searxng': 'searxng',
  'whoogle': 'whoogle',
  'wikipedia': '_external_', // Wikipedia is internet-based, always available
};

/**
 * Given a connector manifest, find the installed app that provides it
 * and return the primary container's internal URL.
 */
async function resolveConnectorUrl(
  connectorId: string,
): Promise<{ url: string; type: string } | null> {
  // Derive the appId from the connector ID (e.g. "searxng-search" → "searxng")
  const appId = Object.keys(CONNECTOR_APP_MAP).find((key) => connectorId.startsWith(key));
  if (!appId) return null;

  const mappedAppId = CONNECTOR_APP_MAP[appId];

  // External connectors (Wikipedia) don't need an installed app
  if (mappedAppId === '_external_') return null;

  // Check if the providing app is actually installed
  const meta = await readInstallMetadata(mappedAppId);
  if (!meta) return null;

  // Read the connector manifest for the authoritative endpoint URL
  try {
    const connectorManifest = await fetchConnectorManifest(connectorId);
    // The connector manifest has the correct container name in its API endpoints.
    // Extract the base URL from the first endpoint definition.
    const firstEndpoint = Object.values(connectorManifest.api?.endpoints ?? {})[0];
    if (firstEndpoint?.url) {
      const urlMatch = firstEndpoint.url.match(/^(https?:\/\/[^/]+)/);
      if (urlMatch) {
        // Replace .incus with current domain suffix in case manifest hasn't been updated
        const url = urlMatch[1].replace(/\.incus([:/])/g, `.${CONTAINER_DOMAIN}$1`)
                                .replace(/\.incus$/, `.${CONTAINER_DOMAIN}`);
        return { url, type: appId };
      }
    }
  } catch {
    // Connector manifest not fetchable — fall back to install metadata
  }

  // Fallback: build URL from install.json container names
  // For multi-container apps, find the primary (usually the one with "main" in the name)
  const containers = meta.containers ?? [];
  const primary = containers.find((c: string) => c.includes('main')) ?? containers[0];
  if (!primary) return null;

  // Use well-known ports per app type
  const portMap: Record<string, number> = { searxng: 8080, whoogle: 5000 };
  const port = portMap[mappedAppId] ?? 3000;

  return { url: `http://${primary}.${CONTAINER_DOMAIN}:${port}`, type: appId };
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
    // Find a connector that provides this capability
    const connector = await findConnectorByCapability(req.capability);
    if (!connector) continue;

    const resolved = await resolveConnectorUrl(connector.metadata.id);
    if (!resolved) continue;

    // Inject env vars based on capability type
    if (req.capability === 'search-engine') {
      env.SEARCH_ENGINE_URL = resolved.url;
      env.SEARCH_ENGINE_TYPE = resolved.type;
    }
    // Future capabilities (media-server, cloud-storage, etc.) add cases here
  }

  return env;
}
