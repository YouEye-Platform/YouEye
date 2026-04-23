import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { connectorDefaults } from "@/db/schema";
import { eq } from "drizzle-orm";
import { listConnectors } from "@/lib/connectors/registry";

/**
 * GET /api/settings/admin/connector-defaults
 * List all admin-configured default connectors per capability.
 * Returns available capabilities and their defaults.
 */
export async function GET() {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  await ensureSchema();

  const defaults = await db.select().from(connectorDefaults);

  // Build capability → available connectors map from catalog
  const capabilityMap: Record<string, Array<{ id: string; name: string; network: string }>> = {};
  try {
    const manifests = await listConnectors();
    for (const m of manifests) {
      const provides = Array.isArray(m.metadata.provides) ? m.metadata.provides : [m.metadata.provides];
      for (const cap of provides) {
        if (!capabilityMap[cap]) capabilityMap[cap] = [];
        capabilityMap[cap].push({
          id: m.metadata.id,
          name: m.metadata.name,
          network: m.metadata.network,
        });
      }
    }
  } catch { /* offline */ }

  return NextResponse.json({
    defaults: defaults.map((d) => ({
      capability: d.capability,
      connectorId: d.connectorId,
      hasSharedKey: !!d.sharedKeyEncrypted,
      setAt: d.setAt,
    })),
    capabilities: capabilityMap,
  });
}

/**
 * POST /api/settings/admin/connector-defaults
 * Set or update a default connector for a capability.
 * Body: { capability, connectorId, sharedKey? }
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  await ensureSchema();

  const body = await request.json();
  const { capability, connectorId } = body;

  if (!capability || !connectorId) {
    return NextResponse.json({ error: "Missing capability or connectorId" }, { status: 400 });
  }

  // Upsert the default
  const existing = await db.select().from(connectorDefaults).where(eq(connectorDefaults.capability, capability)).limit(1);

  if (existing.length > 0) {
    await db
      .update(connectorDefaults)
      .set({
        connectorId,
        setBy: session.userId,
        setAt: new Date(),
      })
      .where(eq(connectorDefaults.capability, capability));
  } else {
    await db.insert(connectorDefaults).values({
      capability,
      connectorId,
      setBy: session.userId,
      setAt: new Date(),
    });
  }

  return NextResponse.json({ ok: true });
}

/**
 * DELETE /api/settings/admin/connector-defaults
 * Remove a default connector for a capability.
 * Body: { capability }
 */
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  await ensureSchema();

  const body = await request.json();
  const { capability } = body;

  if (!capability) {
    return NextResponse.json({ error: "Missing capability" }, { status: 400 });
  }

  await db.delete(connectorDefaults).where(eq(connectorDefaults.capability, capability));

  return NextResponse.json({ ok: true });
}
