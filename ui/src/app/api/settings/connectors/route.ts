import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { apps, userConnectors } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const CP_API_URL = process.env.CP_API_URL ?? "http://youeye-control.youeye:3000/api";

interface ConnectorSummary {
  id: string;
  provides: string[];
}

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const installedApps = await db.select().from(apps).orderBy(apps.displayOrder);

  let connectorCatalog: ConnectorSummary[] = [];
  try {
    const res = await fetch(`${CP_API_URL}/connectors`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      connectorCatalog = data.connectors ?? [];
    }
  } catch { /* offline — show apps without connector data */ }

  const userPrefs = await db
    .select()
    .from(userConnectors)
    .where(eq(userConnectors.userId, session.userId));

  const result = installedApps.map((app) => {
    const manifest = app.manifest as Record<string, unknown> | null;
    const connectorReqs = (manifest?.connectors as { requires?: Array<{ capability: string }> })?.requires ?? [];
    const capabilities = connectorReqs.map((r) => r.capability);
    const isExternalApp = !app.id.startsWith("ye-") && capabilities.length === 0;

    const connected = capabilities.filter((cap) =>
      userPrefs.some(
        (p) =>
          p.capability === cap &&
          p.enabled &&
          (p.consumerApp === app.id || p.consumerApp === null)
      )
    );

    return {
      id: app.id,
      name: app.name,
      icon: app.icon,
      subdomain: app.subdomain,
      enabled: app.enabled,
      status: app.status,
      isExternalApp,
      capabilities,
      connectedCount: connected.length,
      totalCapabilities: capabilities.length,
    };
  });

  return NextResponse.json({ apps: result, connectors: connectorCatalog });
}
