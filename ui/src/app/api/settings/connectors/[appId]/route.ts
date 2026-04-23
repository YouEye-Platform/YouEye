import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { apps, userConnectors, userConnectorSecrets, connectorDefaults } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { listConnectors } from "@/lib/connectors/registry";
import { discoverBackends } from "@/lib/db/queries/connectors";
import { listProviders, getUserToken } from "@/lib/db/queries/auth-providers";
import { connectorLogoUrl } from "@/lib/connectors/logos";

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
  const connectorsDef = manifest?.connectors as {
    requires?: Array<{ capability: string; multiple?: boolean }>;
    consumes?: Array<{ capability: string; multiple?: boolean }>;
  } | undefined;
  const connectorReqs = connectorsDef?.requires ?? connectorsDef?.consumes ?? [];

  // One-Way Bridge: fetch connector catalog directly from Gitea via local registry
  let connectorCatalog: Array<{
    id: string;
    name: string;
    icon: string;
    provides: string[];
    network: string;
    authMethod: string;
    authProvider?: string;
    hasCompatibleApps: boolean;
    configFields: Array<{
      name: string; label: string; type: string;
      required: boolean; managed: boolean;
    }>;
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
      authProvider: m.permissions.auth.provider,
      hasCompatibleApps: !!m.metadata.compatibleApps?.length,
      configFields: m.config.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        required: f.required,
        managed: f.managed ?? false,
      })),
    }));
  } catch { /* offline — Gitea unreachable */ }

  // Fetch auth providers for OAuth-managed connectors
  let providers: Array<{ id: string; slug: string; name: string; enabled: boolean }> = [];
  try {
    providers = await listProviders();
  } catch { /* no providers yet */ }

  // Check which providers the user has tokens for
  const providerTokenStatus: Record<string, boolean> = {};
  for (const p of providers) {
    try {
      const token = await getUserToken(session.userId, p.id);
      providerTokenStatus[p.slug] = !!token;
    } catch {
      providerTokenStatus[p.slug] = false;
    }
  }

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

  // Fetch admin defaults for capability comparison
  let defaults: Array<{ capability: string; connectorId: string }> = [];
  try {
    defaults = await db.select({
      capability: connectorDefaults.capability,
      connectorId: connectorDefaults.connectorId,
    }).from(connectorDefaults);
  } catch { /* table may not exist yet */ }

  const capabilities = await Promise.all(connectorReqs.map(async (req) => {
    const matchingConnectors = connectorCatalog.filter((c) =>
      c.provides.includes(req.capability)
    );

    const connections = userPrefs.filter(
      (p) =>
        p.capability === req.capability &&
        p.enabled &&
        (p.consumerApp === appId || p.consumerApp === null)
    );

    const defaultConnectorId = defaults.find((d) => d.capability === req.capability)?.connectorId;

    const connectorDetails = await Promise.all(matchingConnectors.map(async (c) => {
      // For managed fields, check if the auth provider token exists
      const managedFields = c.configFields.filter((f) => f.managed);
      const manualFields = c.configFields.filter((f) => !f.managed && f.required);

      const managedCredsOk = managedFields.length === 0 ||
        (c.authProvider && providerTokenStatus[c.authProvider]);
      const manualCredsOk = manualFields.length === 0 ||
        manualFields.every((f) =>
          secrets.some((s) => s.connectorId === c.id && s.key === f.name)
        );

      const hasRequiredCreds = c.authMethod === "none" ||
        (managedCredsOk && manualCredsOk);

      // Find matching auth provider for OAuth connectors
      const matchingProvider = c.authProvider
        ? providers.find((p) => p.slug === c.authProvider)
        : undefined;

      // Backend discovery for connectors backed by installed apps
      let backends: { appId: string; appName: string; installed: boolean; internalUrl: string | null }[] = [];
      try {
        const discovered = await discoverBackends(c.id);
        backends = discovered.map((b) => ({
          appId: b.appId,
          appName: b.appName,
          installed: b.installed,
          internalUrl: b.internalUrl,
        }));
      } catch { /* no backends */ }

      // Availability: internet connectors always available;
      // local connectors only available if a backend is installed OR user has a custom URL
      const userPref = connections.find((conn) => conn.connectorId === c.id);
      const userConfig = userPref
        ? userPrefs.find((p) => p.id === userPref.id)?.config as Record<string, unknown> | null
        : null;
      const hasCustomUrl = !!userConfig?.customUrl;
      const hasInstalledBackend = backends.some((b) => b.installed);
      const available = c.network === "internet" || hasInstalledBackend || hasCustomUrl;

      return {
        id: c.id,
        name: c.name,
        icon: c.icon,
        logoUrl: connectorLogoUrl(c.id),
        network: c.network,
        authMethod: c.authMethod,
        authProvider: c.authProvider,
        authProviderName: matchingProvider?.name,
        authProviderConnected: c.authProvider
          ? providerTokenStatus[c.authProvider] ?? false
          : undefined,
        configFields: c.configFields,
        credentialsConfigured: hasRequiredCreds,
        backends,
        available,
        hasCompatibleApps: c.hasCompatibleApps,
        isDefault: c.id === defaultConnectorId,
        customUrl: (userConfig?.customUrl as string) ?? null,
      };
    }));

    return {
      capability: req.capability,
      multiple: req.multiple ?? false,
      availableConnectors: connectorDetails,
      connections: connections.map((c) => ({
        id: c.id,
        connectorId: c.connectorId,
        persistent: c.persistent,
      })),
    };
  }));

  // Extract link handlers (info_cards with triggers) from manifest
  const infoCards = (manifest?.info_cards as Array<{
    type: string;
    description?: string;
    endpoint: string;
    triggers?: string[];
  }>) ?? [];
  const linkHandlers = infoCards
    .filter((card) => card.triggers && card.triggers.length > 0)
    .map((card) => ({
      type: card.type,
      description: card.description ?? card.type,
      endpoint: card.endpoint,
      triggers: card.triggers!,
    }));

  return NextResponse.json({
    app: {
      id: app.id,
      name: app.name,
      icon: app.icon,
      subdomain: app.subdomain,
    },
    capabilities,
    linkHandlers,
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
  const { action, capability, connectorId, persistent = true, config } = body;

  if (action === "connect") {
    if (!capability || !connectorId) {
      return NextResponse.json({ error: "Missing capability or connectorId" }, { status: 400 });
    }

    const connectorConfig = config ?? {};

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
        .set({ enabled: true, persistent, config: connectorConfig, updatedAt: new Date() })
        .where(eq(userConnectors.id, existing[0].id));
    } else {
      await db.insert(userConnectors).values({
        userId: session.userId,
        connectorId,
        capability,
        consumerApp: appId,
        persistent,
        config: connectorConfig,
      });
    }

    return NextResponse.json({ ok: true });
  }

  if (action === "update-config") {
    if (!capability || !connectorId || !config) {
      return NextResponse.json({ error: "Missing capability, connectorId, or config" }, { status: 400 });
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
      const merged = { ...(existing[0].config as Record<string, unknown> ?? {}), ...config };
      await db
        .update(userConnectors)
        .set({ config: merged, updatedAt: new Date() })
        .where(eq(userConnectors.id, existing[0].id));
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Connector not connected" }, { status: 404 });
  }

  if (action === "test-connection") {
    const { url } = body;
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "Missing url" }, { status: 400 });
    }
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ ok: false, error: "Invalid URL" }, { status: 400 });
    }
    try {
      const res = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        headers: { "User-Agent": "YouEye-ConnectorTest/1.0" },
      });
      return NextResponse.json({
        ok: true,
        status: res.status,
        reachable: res.ok,
      });
    } catch (err) {
      return NextResponse.json({
        ok: false,
        error: err instanceof Error ? err.message : "Connection failed",
        reachable: false,
      });
    }
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
