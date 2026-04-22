import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { apps, userConnectors, userConnectorSecrets } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listConnectors } from "@/lib/connectors/registry";
import { discoverBackends } from "@/lib/db/queries/connectors";
import type { ConnectorManifest } from "@/lib/connectors/schema";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const installedApps = await db.select().from(apps).orderBy(apps.displayOrder);

  // Fetch full connector catalog from Gitea
  let allManifests: ConnectorManifest[] = [];
  try {
    allManifests = await listConnectors();
  } catch { /* offline */ }

  // Gather all capabilities from native apps' connector requirements
  const capabilityMap = new Map<string, { consumingApps: { id: string; name: string }[] }>();

  for (const app of installedApps) {
    const manifest = app.manifest as Record<string, unknown> | null;
    const connectors = manifest?.connectors as {
      requires?: Array<{ capability: string }>;
      consumes?: Array<{ capability: string }>;
    } | undefined;
    const reqs = connectors?.requires ?? connectors?.consumes ?? [];
    for (const req of reqs) {
      const existing = capabilityMap.get(req.capability);
      if (existing) {
        existing.consumingApps.push({ id: app.id, name: app.name });
      } else {
        capabilityMap.set(req.capability, {
          consumingApps: [{ id: app.id, name: app.name }],
        });
      }
    }
  }

  // Also include capabilities from connectors that have no consuming app yet
  // (e.g. user might want to browse all available capabilities)
  for (const m of allManifests) {
    const provides = Array.isArray(m.metadata.provides)
      ? m.metadata.provides
      : [m.metadata.provides];
    for (const cap of provides) {
      if (!capabilityMap.has(cap)) {
        capabilityMap.set(cap, { consumingApps: [] });
      }
    }
  }

  // User preferences and secrets
  const userPrefs = await db
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.userId, session.userId));

  const secrets = await db
    .select({
      connectorId: userConnectorSecrets.connectorId,
      key: userConnectorSecrets.key,
    })
    .from(userConnectorSecrets)
    .where(eq(userConnectorSecrets.userId, session.userId));

  // Build capability-centric response
  const capabilities = await Promise.all(
    Array.from(capabilityMap.entries()).map(async ([capability, { consumingApps }]) => {
      // Find connectors that provide this capability
      const connectors = allManifests.filter((m) => {
        const provides = Array.isArray(m.metadata.provides)
          ? m.metadata.provides
          : [m.metadata.provides];
        return provides.includes(capability);
      });

      // Build connector details with backend discovery
      const availableConnectors = await Promise.all(
        connectors.map(async (m) => {
          const source = m.metadata.source ?? "external";
          const authMethod = m.permissions.auth.method;
          const requiredFields = m.config.fields
            .filter((f) => f.required)
            .map((f) => f.name);

          const credentialsConfigured =
            authMethod === "none" ||
            requiredFields.every((field) =>
              secrets.some((s) => s.connectorId === m.metadata.id && s.key === field)
            );

          // Discover backends for internal/both connectors
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

          return {
            id: m.metadata.id,
            name: m.metadata.name,
            icon: m.metadata.icon,
            source,
            network: m.metadata.network,
            authMethod,
            credentialsConfigured,
            backends,
          };
        })
      );

      // Find active connection for this capability
      const activePrefs = userPrefs.filter(
        (p) => p.capability === capability && p.enabled
      );

      let activeConnector: {
        connectorId: string;
        name: string;
        source: string;
        autoWired: boolean;
        credentialsConfigured: boolean;
      } | null = null;

      if (activePrefs.length > 0) {
        const pref = activePrefs[0];
        const ac = availableConnectors.find((c) => c.id === pref.connectorId);
        activeConnector = {
          connectorId: pref.connectorId,
          name: ac?.name ?? pref.connectorId,
          source: ac?.source ?? "external",
          autoWired: false,
          credentialsConfigured: ac?.credentialsConfigured ?? false,
        };
      } else {
        // Check auto-wire candidates
        // Rule 1: internal/both + auth:none + exactly 1 installed backend
        for (const c of availableConnectors) {
          if (c.source === "external") continue;
          if (c.authMethod !== "none") continue;
          const installedBackends = c.backends.filter((b) => b.installed);
          if (installedBackends.length === 1) {
            activeConnector = {
              connectorId: c.id,
              name: c.name,
              source: c.source,
              autoWired: true,
              credentialsConfigured: true,
            };
            break;
          }
        }
        // Rule 2: external + auth:none
        if (!activeConnector) {
          for (const c of availableConnectors) {
            if (c.source !== "external") continue;
            if (c.authMethod !== "none") continue;
            activeConnector = {
              connectorId: c.id,
              name: c.name,
              source: c.source,
              autoWired: true,
              credentialsConfigured: true,
            };
            break;
          }
        }
      }

      return {
        capability,
        consumingApps,
        activeConnector,
        availableConnectors,
      };
    })
  );

  return NextResponse.json({ capabilities, isAdmin: session.isAdmin });
}
