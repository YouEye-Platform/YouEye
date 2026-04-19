/**
 * Connector Queries
 *
 * Manages user connector preferences and resolution.
 * The connector system lets users choose which data sources
 * their apps connect to (e.g., SearXNG vs Whoogle for search).
 */

import { db, ensureSchema } from "@/db";
import { userConnectors, userConnectorSecrets, appPermissions } from "@/db/schema";
import { eq, and, asc, isNull } from "drizzle-orm";

const CP_API_URL = process.env.CP_API_URL ?? "http://youeye-control.youeye:3000/api";
const CONNECTOR_RUNTIME_URL = process.env.CONNECTOR_RUNTIME_URL ?? "http://youeye-connectors.youeye:3001";

/**
 * Resolve which connector a user should use for a given capability.
 * Resolution order:
 * 1. User's app-specific preference (consumer_app matches)
 * 2. User's default preference (consumer_app is null)
 * 3. First available connector from the CP registry
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
  permission: "granted" | "pending" | "denied";
  approvalUrl?: string;
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

  // 3. If no preference, get first available from CP registry
  let connectorId: string;
  let connectorInfo: { name: string; network: string; authMethod: string; configFields: Array<{ name: string; required: boolean }> };

  if (pref) {
    connectorId = pref.connectorId;
    // Fetch connector info from CP
    const info = await fetchConnectorInfo(connectorId);
    if (!info) return null;
    connectorInfo = info;
  } else {
    // Query CP for any connector with this capability
    const available = await fetchConnectorsByCapability(capability);
    if (available.length === 0) return null;
    connectorId = available[0].id;
    connectorInfo = available[0];
  }

  // Check permission
  const permissionKey = `connector:${capability}`;
  const [permRow] = await db
    .select({ granted: appPermissions.granted })
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId),
        eq(appPermissions.permission, permissionKey)
      )
    )
    .limit(1);

  const permission: "granted" | "pending" | "denied" = permRow?.granted
    ? "granted"
    : "pending";

  // Check credentials
  const requiresCredentials = connectorInfo.authMethod !== "none" &&
    connectorInfo.configFields.some((f) => f.required);

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
    const requiredFields = connectorInfo.configFields
      .filter((f) => f.required)
      .map((f) => f.name);
    credentialsConfigured = requiredFields.every((field) =>
      secrets.some((s) => s.key === field)
    );
  }

  const uiBaseUrl = process.env.UI_EXTERNAL_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? "";

  return {
    connectorId,
    name: connectorInfo.name,
    capability,
    network: connectorInfo.network,
    proxyBaseUrl: `${CONNECTOR_RUNTIME_URL}/proxy`,
    permission,
    approvalUrl: permission === "pending"
      ? `${uiBaseUrl}/permissions/grant?app=${encodeURIComponent(appId)}&capability=${encodeURIComponent(capability)}&connector=${encodeURIComponent(connectorId)}`
      : undefined,
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

// ─── CP Registry Helpers ──────────────────────────────────

async function fetchConnectorInfo(connectorId: string) {
  try {
    const res = await fetch(`${CP_API_URL}/connectors`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const connector = data.connectors?.find((c: { id: string }) => c.id === connectorId);
    return connector ?? null;
  } catch {
    return null;
  }
}

async function fetchConnectorsByCapability(capability: string) {
  try {
    const res = await fetch(
      `${CP_API_URL}/connectors?capability=${encodeURIComponent(capability)}`,
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.connectors ?? [];
  } catch {
    return [];
  }
}
