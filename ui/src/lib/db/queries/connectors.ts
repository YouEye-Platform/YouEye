/**
 * Connector Queries
 *
 * Manages user connector preferences and resolution.
 * The connector system lets users choose which data sources
 * their apps connect to (e.g., SearXNG vs Whoogle for search).
 *
 * One-Way Bridge: Connector catalog fetched directly from Gitea,
 * not proxied through CP.
 */

import { db, ensureSchema } from "@/db";
import { userConnectors, userConnectorSecrets, apps } from "@/db/schema";
import { eq, and, asc, isNull } from "drizzle-orm";
import {
  fetchConnectorManifest,
  listConnectors,
} from "@/lib/connectors/registry";
import type { ConnectorManifest } from "@/lib/connectors/schema";

const CONNECTOR_RUNTIME_URL = process.env.CONNECTOR_RUNTIME_URL ?? "http://youeye-connectors.youeye:3001";

/**
 * Resolve which connector a user should use for a given capability.
 *
 * Connection model: selecting a connector IS the permission.
 * No separate permission table — an enabled user_connectors row = granted.
 * No row = not-connected (return null, caller shows setup flow).
 *
 * Resolution order:
 * 1. User's app-specific preference (consumer_app matches)
 * 2. User's default preference (consumer_app is null)
 * 3. null — not connected (no auto-fallback to catalog)
 */
export async function resolveConnector(
  userId: string,
  capability: string,
  appId: string
): Promise<{
  connectorId: string;
  name: string;
  capability: string;
  network: string;
  source: string;
  proxyBaseUrl: string;
  permission: "granted";
  requiresCredentials: boolean;
  credentialsConfigured: boolean;
  autoWired: boolean;
  baseUrl?: string;
} | null> {
  await ensureSchema();

  // 1. Check user's app-specific preference
  let [pref] = await db
    .select()
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.capability, capability),
        eq(userConnectors.consumerApp, appId),
        eq(userConnectors.enabled, true)
      )
    )
    .orderBy(asc(userConnectors.priority))
    .limit(1);

  // 2. Check user's default preference
  if (!pref) {
    [pref] = await db
      .select()
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.userId, userId),
          eq(userConnectors.capability, capability),
          isNull(userConnectors.consumerApp),
          eq(userConnectors.enabled, true)
        )
      )
      .orderBy(asc(userConnectors.priority))
      .limit(1);
  }

  // No explicit preference — try auto-wiring
  if (!pref) {
    const autoResult = await tryAutoWire(capability);
    if (autoResult) return autoResult;
    return null;
  }

  const connectorId = pref.connectorId;
  const info = await fetchConnectorInfo(connectorId);
  if (!info) return null;

  // Check credentials
  const requiresCredentials = info.authMethod !== "none" &&
    info.configFields.some((f) => f.required);

  let credentialsConfigured = !requiresCredentials;
  if (requiresCredentials) {
    const secrets = await db
      .select()
      .from(userConnectorSecrets)
      .where(
        and(
          eq(userConnectorSecrets.userId, userId),
          eq(userConnectorSecrets.connectorId, connectorId)
        )
      );
    const requiredFields = info.configFields
      .filter((f) => f.required)
      .map((f) => f.name);
    credentialsConfigured = requiredFields.every((field) =>
      secrets.some((s) => s.key === field)
    );
  }

  // Selecting a connector IS the permission — always "granted"
  return {
    connectorId,
    name: info.name,
    capability,
    network: info.network,
    source: info.source,
    proxyBaseUrl: `${CONNECTOR_RUNTIME_URL}/proxy`,
    permission: "granted",
    requiresCredentials,
    credentialsConfigured,
    autoWired: false,
  };
}

/**
 * Try auto-wiring a connector for a given capability.
 *
 * Auto-wire rules (in priority order):
 * 1. If exactly 1 compatible app is installed with auth: none → auto-connect
 * 2. External connector with auth: none (Open-Meteo, Wikipedia) → auto-connect
 * 3. Otherwise → null (user must choose manually)
 */
async function tryAutoWire(capability: string): Promise<{
  connectorId: string;
  name: string;
  capability: string;
  network: string;
  source: string;
  proxyBaseUrl: string;
  permission: "granted";
  requiresCredentials: boolean;
  credentialsConfigured: boolean;
  autoWired: boolean;
  baseUrl?: string;
} | null> {
  const connectors = await listConnectors(capability);

  // Rule 1: Check for internal/both connectors with exactly one installed backend
  for (const connector of connectors) {
    const source = connector.metadata.source ?? "external";
    if (source === "external") continue;
    if (connector.permissions.auth.method !== "none") continue;

    const compatApps = connector.metadata.compatibleApps;
    if (!compatApps?.length) continue;

    const backends = await discoverBackends(connector.metadata.id);
    const installedBackends = backends.filter((b) => b.installed);

    if (installedBackends.length === 1) {
      return {
        connectorId: connector.metadata.id,
        name: connector.metadata.name,
        capability,
        network: connector.metadata.network,
        source,
        proxyBaseUrl: `${CONNECTOR_RUNTIME_URL}/proxy`,
        permission: "granted",
        requiresCredentials: false,
        credentialsConfigured: true,
        autoWired: true,
        baseUrl: installedBackends[0].internalUrl ?? undefined,
      };
    }
  }

  // Rule 2: External connectors with auth: none (e.g., Open-Meteo, Wikipedia)
  for (const connector of connectors) {
    const source = connector.metadata.source ?? "external";
    if (source !== "external") continue;
    if (connector.permissions.auth.method !== "none") continue;

    return {
      connectorId: connector.metadata.id,
      name: connector.metadata.name,
      capability,
      network: connector.metadata.network,
      source,
      proxyBaseUrl: `${CONNECTOR_RUNTIME_URL}/proxy`,
      permission: "granted",
      requiresCredentials: false,
      credentialsConfigured: true,
      autoWired: true,
    };
  }

  return null;
}

/**
 * Set a user's preferred connector for a capability.
 */
export async function setUserConnector(
  userId: string,
  connectorId: string,
  capability: string,
  consumerApp?: string
): Promise<void> {
  await ensureSchema();

  const existing = await db
    .select({ id: userConnectors.id })
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, userId),
        eq(userConnectors.connectorId, connectorId),
        consumerApp
          ? eq(userConnectors.consumerApp, consumerApp)
          : isNull(userConnectors.consumerApp)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userConnectors)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(userConnectors.id, existing[0].id));
  } else {
    await db.insert(userConnectors).values({
      userId,
      connectorId,
      capability,
      consumerApp: consumerApp ?? null,
    });
  }
}

/**
 * Get all connector preferences for a user.
 */
export async function getUserConnectors(userId: string) {
  await ensureSchema();
  return db
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.userId, userId))
    .orderBy(asc(userConnectors.capability), asc(userConnectors.priority));
}

// ─── Backend Discovery ────────────────────────────────────

export interface ConnectorBackend {
  connectorId: string;
  appId: string;
  appName: string;
  installed: boolean;
  internalUrl: string | null;
}

/**
 * Discover which installed apps can back a given connector.
 * Cross-references the connector's `compatibleApps` against the installed apps table.
 */
export async function discoverBackends(
  connectorId: string
): Promise<ConnectorBackend[]> {
  const manifest = await fetchConnectorManifest(connectorId);
  const compatibleApps = manifest.metadata.compatibleApps;
  if (!compatibleApps?.length) return [];

  await ensureSchema();
  const installedApps = await db.select().from(apps).where(eq(apps.enabled, true));

  return compatibleApps.map((compat) => {
    const installed = installedApps.find((a) => a.id === compat.appId);
    // Build internal URL from container URL + configured port
    let internalUrl: string | null = null;
    if (installed?.containerUrl) {
      // containerUrl might already include protocol+port, or just be a hostname
      const url = installed.containerUrl;
      if (url.startsWith("http")) {
        // Already a full URL — use the host but override the port
        try {
          const parsed = new URL(url);
          internalUrl = `${compat.protocol}://${parsed.hostname}:${compat.defaultPort}`;
        } catch {
          internalUrl = `${compat.protocol}://${url}:${compat.defaultPort}`;
        }
      } else {
        internalUrl = `${compat.protocol}://${url}:${compat.defaultPort}`;
      }
    }

    return {
      connectorId,
      appId: compat.appId,
      appName: installed?.name ?? compat.appId,
      installed: !!installed,
      internalUrl,
    };
  });
}

/**
 * Discover backends for all connectors that provide a given capability.
 */
export async function discoverBackendsByCapability(
  capability: string
): Promise<{ connectorId: string; name: string; source: string; backends: ConnectorBackend[] }[]> {
  const connectors = await listConnectors(capability);
  const results: { connectorId: string; name: string; source: string; backends: ConnectorBackend[] }[] = [];

  for (const connector of connectors) {
    const backends = await discoverBackends(connector.metadata.id);
    results.push({
      connectorId: connector.metadata.id,
      name: connector.metadata.name,
      source: connector.metadata.source ?? "external",
      backends,
    });
  }

  return results;
}

// ─── Registry Helpers (Direct Gitea Fetch) ─────────────────

/**
 * Convert ConnectorManifest to the info format used by resolveConnector.
 */
function manifestToInfo(manifest: ConnectorManifest) {
  return {
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    network: manifest.metadata.network,
    source: manifest.metadata.source ?? "external",
    authMethod: manifest.permissions.auth.method,
    configFields: manifest.config.fields.map((f) => ({
      name: f.name,
      required: f.required,
    })),
  };
}

/**
 * Fetch connector info by ID — directly from Gitea via local registry.
 */
async function fetchConnectorInfo(connectorId: string) {
  try {
    const manifest = await fetchConnectorManifest(connectorId);
    return manifestToInfo(manifest);
  } catch {
    return null;
  }
}

/**
 * Fetch connectors by capability — directly from Gitea via local registry.
 */
async function fetchConnectorsByCapability(capability: string) {
  try {
    const manifests = await listConnectors(capability);
    return manifests.map(manifestToInfo);
  } catch {
    return [];
  }
}
