/**
 * GET /api/settings/connectors/capability/[capability]
 * Returns detailed connector info for a single capability, including
 * source grouping, backend discovery, and user preferences.
 *
 * POST — connect/disconnect a connector for this capability (default preference)
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { userConnectors, userConnectorSecrets } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { listConnectors } from "@/lib/connectors/registry";
import { discoverBackends } from "@/lib/db/queries/connectors";
import { listProviders, getUserToken } from "@/lib/db/queries/auth-providers";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ capability: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { capability } = await params;
  await ensureSchema();

  // Fetch all connectors for this capability
  const manifests = await listConnectors(capability);

  // Auth providers for OAuth connectors
  let providers: Array<{ id: string; slug: string; name: string; enabled: boolean }> = [];
  try {
    providers = await listProviders();
  } catch { /* no providers */ }

  const providerTokenStatus: Record<string, boolean> = {};
  for (const p of providers) {
    try {
      const token = await getUserToken(session.userId, p.id);
      providerTokenStatus[p.slug] = !!token;
    } catch {
      providerTokenStatus[p.slug] = false;
    }
  }

  // User secrets for credential checking
  const secrets = await db
    .select({
      connectorId: userConnectorSecrets.connectorId,
      key: userConnectorSecrets.key,
    })
    .from(userConnectorSecrets)
    .where(eq(userConnectorSecrets.userId, session.userId));

  // User preferences for this capability
  const userPrefs = await db
    .select()
    .from(userConnectors)
    .where(
      and(
        eq(userConnectors.userId, session.userId),
        eq(userConnectors.capability, capability)
      )
    );

  const activeDefault = userPrefs.find(
    (p) => p.enabled && p.consumerApp === null
  );

  // Build connector details
  const connectors = await Promise.all(
    manifests.map(async (m) => {
      const source = m.metadata.source ?? "external";
      const authMethod = m.permissions.auth.method;

      // Config fields with managed status
      const configFields = m.config.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        managed: f.managed ?? false,
      }));

      const managedFields = configFields.filter((f) => f.managed);
      const manualFields = configFields.filter((f) => !f.managed && f.required);

      const managedCredsOk =
        managedFields.length === 0 ||
        (m.permissions.auth.provider &&
          providerTokenStatus[m.permissions.auth.provider]);
      const manualCredsOk =
        manualFields.length === 0 ||
        manualFields.every((f) =>
          secrets.some((s) => s.connectorId === m.metadata.id && s.key === f.name)
        );

      const credentialsConfigured =
        authMethod === "none" || (!!managedCredsOk && manualCredsOk);

      // Backend discovery
      let backends: {
        appId: string;
        appName: string;
        installed: boolean;
        internalUrl: string | null;
      }[] = [];
      if (source !== "external") {
        try {
          backends = await discoverBackends(m.metadata.id);
        } catch { /* no backends */ }
      }

      // Find matching auth provider
      const matchingProvider = m.permissions.auth.provider
        ? providers.find((p) => p.slug === m.permissions.auth.provider)
        : undefined;

      return {
        id: m.metadata.id,
        name: m.metadata.name,
        icon: m.metadata.icon,
        source,
        network: m.metadata.network,
        authMethod,
        authProvider: m.permissions.auth.provider,
        authProviderName: matchingProvider?.name,
        authProviderConnected: m.permissions.auth.provider
          ? providerTokenStatus[m.permissions.auth.provider] ?? false
          : undefined,
        configFields,
        credentialsConfigured,
        backends,
        isActive: activeDefault?.connectorId === m.metadata.id,
      };
    })
  );

  // Separate into groups
  const internal = connectors.filter((c) => c.source !== "external");
  const external = connectors.filter((c) => c.source === "external");

  // Determine auto-wire candidate
  let autoWireConnectorId: string | null = null;
  if (!activeDefault) {
    // Rule 1: internal/both + auth:none + exactly 1 installed backend
    for (const c of internal) {
      if (c.authMethod !== "none") continue;
      const installed = c.backends.filter((b) => b.installed);
      if (installed.length === 1) {
        autoWireConnectorId = c.id;
        break;
      }
    }
    // Rule 2: external + auth:none
    if (!autoWireConnectorId) {
      for (const c of external) {
        if (c.authMethod !== "none") continue;
        autoWireConnectorId = c.id;
        break;
      }
    }
  }

  return NextResponse.json({
    capability,
    internal,
    external,
    activeConnectorId: activeDefault?.connectorId ?? autoWireConnectorId,
    autoWired: !activeDefault && !!autoWireConnectorId,
    isAdmin: session.isAdmin,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ capability: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { capability } = await params;
  await ensureSchema();

  const body = await request.json();
  const { action, connectorId } = body;

  if (action === "connect") {
    if (!connectorId) {
      return NextResponse.json({ error: "Missing connectorId" }, { status: 400 });
    }

    // Disable any existing default preference for this capability
    const existing = await db
      .select()
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.userId, session.userId),
          eq(userConnectors.capability, capability),
          isNull(userConnectors.consumerApp)
        )
      );

    for (const row of existing) {
      await db
        .update(userConnectors)
        .set({ enabled: false, updatedAt: new Date() })
        .where(eq(userConnectors.id, row.id));
    }

    // Check if this connector was previously set
    const prev = existing.find((r) => r.connectorId === connectorId);
    if (prev) {
      await db
        .update(userConnectors)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(userConnectors.id, prev.id));
    } else {
      await db.insert(userConnectors).values({
        userId: session.userId,
        connectorId,
        capability,
        consumerApp: null,
      });
    }

    return NextResponse.json({ ok: true });
  }

  if (action === "disconnect") {
    await db
      .update(userConnectors)
      .set({ enabled: false, updatedAt: new Date() })
      .where(
        and(
          eq(userConnectors.userId, session.userId),
          eq(userConnectors.capability, capability),
          isNull(userConnectors.consumerApp)
        )
      );
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
