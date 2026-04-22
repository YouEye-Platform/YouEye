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
import { userConnectors, userConnectorSecrets } from "@/db/schema";
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
  proxyBaseUrl: string;
  permission: "granted";
  requiresCredentials: boolean;
  credentialsConfigured: boolean;
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

  // No connector selected = not connected. No auto-fallback.
  // The user must explicitly choose a connector via Settings or the setup flow.
  if (!pref) return null;

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
    proxyBaseUrl: `${CONNECTOR_RUNTIME_URL}/proxy`,
    permission: "granted",
    requiresCredentials,
    credentialsConfigured,
  };
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

// ─── Registry Helpers (Direct Gitea Fetch) ─────────────────

/**
 * Convert ConnectorManifest to the info format used by resolveConnector.
 */
function manifestToInfo(manifest: ConnectorManifest) {
  return {
    id: manifest.metadata.id,
    name: manifest.metadata.name,
    network: manifest.metadata.network,
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
