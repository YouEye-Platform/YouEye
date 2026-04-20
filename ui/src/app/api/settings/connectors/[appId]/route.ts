import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { apps, userConnectors, userConnectorSecrets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { listConnectors } from "@/lib/connectors/registry";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  await ensureSchema();

  const [app] = await db.select().from(apps).where(eq(apps.id, appId)).limit(1);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const manifest = app.manifest as Record<string, unknown> | null;
  const connectorReqs = (manifest?.connectors as {
    requires?: Array<{ capability: string; multiple?: boolean }>;
  })?.requires ?? [];

  // One-Way Bridge: fetch connector catalog directly from Gitea via local registry
  let connectorCatalog: Array<{
    id: string;
    name: string;
    icon: string;
    provides: string[];
    network: string;
    authMethod: string;
    configFields: Array<{ name: string; label: string; type: string; required: boolean }>;
  }> = [];
  try {
    const manifests = await listConnectors();
    connectorCatalog = manifests.map((m) => ({
      id: m.metadata.id,
      name: m.metadata.name,
      icon: m.metadata.icon,
      provides: m.metadata.provides,
      network: m.metadata.network,
      authMethod: m.permissions.auth.method,
      configFields: m.config.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
      })),
    }));
  } catch { /* offline — Gitea unreachable */ }

  const userPrefs = await db
    .select()
    .from(userConnectors)
    .where(
      and(eq(userConnectors.userId, session.userId))
    );

  const secrets = await db
    .select({
      connectorId: userConnectorSecrets.connectorId,
      key: userConnectorSecrets.key,
      boundHost: userConnectorSecrets.boundHost,
    })
    .from(userConnectorSecrets)
    .where(eq(userConnectorSecrets.userId, session.userId));

  const capabilities = connectorReqs.map((req) => {
    const availableConnectors = connectorCatalog.filter((c) =>
      c.provides.includes(req.capability)
    );

    const connections = userPrefs.filter(
      (p) =>
        p.capability === req.capability &&
        p.enabled &&
        (p.consumerApp === appId || p.consumerApp === null)
    );

    return {
      capability: req.capability,
      multiple: req.multiple ?? false,
      availableConnectors: availableConnectors.map((c) => {
        const hasRequiredCreds = c.authMethod === "none" ||
          c.configFields
            .filter((f) => f.required)
            .every((f) => secrets.some((s) => s.connectorId === c.id && s.key === f.name));

        return {
          id: c.id,
          name: c.name,
          icon: c.icon,
          network: c.network,
          authMethod: c.authMethod,
          configFields: c.configFields,
          credentialsConfigured: hasRequiredCreds,
        };
      }),
      connections: connections.map((c) => ({
        id: c.id,
        connectorId: c.connectorId,
        persistent: c.persistent,
      })),
    };
  });

  return NextResponse.json({
    app: {
      id: app.id,
      name: app.name,
      icon: app.icon,
      subdomain: app.subdomain,
    },
    capabilities,
    isAdmin: session.isAdmin,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  await ensureSchema();

  const body = await request.json();
  const { action, capability, connectorId, persistent = true } = body;

  if (action === "connect") {
    if (!capability || !connectorId) {
      return NextResponse.json({ error: "Missing capability or connectorId" }, { status: 400 });
    }

    const existing = await db
      .select()
      .from(userConnectors)
      .where(
        and(
          eq(userConnectors.userId, session.userId),
          eq(userConnectors.capability, capability),
          eq(userConnectors.consumerApp, appId),
          eq(userConnectors.connectorId, connectorId)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(userConnectors)
        .set({ enabled: true, persistent, updatedAt: new Date() })
        .where(eq(userConnectors.id, existing[0].id));
    } else {
      await db.insert(userConnectors).values({
        userId: session.userId,
        connectorId,
        capability,
        consumerApp: appId,
        persistent,
      });
    }

    return NextResponse.json({ ok: true });
  }

  if (action === "disconnect") {
    if (!capability) {
      return NextResponse.json({ error: "Missing capability" }, { status: 400 });
    }

    if (connectorId) {
      await db
        .update(userConnectors)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(userConnectors.userId, session.userId),
            eq(userConnectors.capability, capability),
            eq(userConnectors.consumerApp, appId),
            eq(userConnectors.connectorId, connectorId)
          )
        );
    } else {
      await db
        .update(userConnectors)
        .set({ enabled: false, updatedAt: new Date() })
        .where(
          and(
            eq(userConnectors.userId, session.userId),
            eq(userConnectors.capability, capability),
            eq(userConnectors.consumerApp, appId)
          )
        );
    }

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
