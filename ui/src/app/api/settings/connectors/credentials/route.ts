import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { db, ensureSchema } from "@/db";
import { userConnectorSecrets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchConnectorManifest } from "@/lib/connectors/registry";

const ENCRYPTION_KEY = process.env.CONNECTOR_ENCRYPTION_KEY || "youeye-dev-key-32bytes-padding!";

async function encryptValue(value: string): Promise<{ encrypted: string; nonce: string }> {
  const crypto = await import("node:crypto");
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "!").slice(0, 32));
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, authTag]).toString("base64"),
    nonce: iv.toString("base64"),
  };
}

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const body = await request.json();
  const { connectorId, key, value } = body;
  let { boundHost } = body;

  if (!connectorId || !key || !value) {
    return NextResponse.json({ error: "Missing connectorId, key, or value" }, { status: 400 });
  }

  // Auto-derive boundHost from connector manifest if not provided
  // One-Way Bridge: fetch directly from Gitea via local registry
  if (!boundHost) {
    try {
      const manifest = await fetchConnectorManifest(connectorId);
      const hosts = manifest.permissions?.network?.allowedHosts;
      if (Array.isArray(hosts) && hosts.length === 1) {
        boundHost = hosts[0];
      }
    } catch { /* proceed without boundHost */ }
  }

  const { encrypted, nonce } = await encryptValue(value);

  const existing = await db
    .select()
    .from(userConnectorSecrets)
    .where(
      and(
        eq(userConnectorSecrets.userId, session.userId),
        eq(userConnectorSecrets.connectorId, connectorId),
        eq(userConnectorSecrets.key, key)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(userConnectorSecrets)
      .set({
        encryptedValue: encrypted,
        nonce,
        boundHost: boundHost ?? null,
      })
      .where(eq(userConnectorSecrets.id, existing[0].id));
  } else {
    await db.insert(userConnectorSecrets).values({
      userId: session.userId,
      connectorId,
      key,
      encryptedValue: encrypted,
      nonce,
      boundHost: boundHost ?? null,
    });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureSchema();

  const body = await request.json();
  const { connectorId, key } = body;

  if (!connectorId) {
    return NextResponse.json({ error: "Missing connectorId" }, { status: 400 });
  }

  if (key) {
    await db
      .delete(userConnectorSecrets)
      .where(
        and(
          eq(userConnectorSecrets.userId, session.userId),
          eq(userConnectorSecrets.connectorId, connectorId),
          eq(userConnectorSecrets.key, key)
        )
      );
  } else {
    await db
      .delete(userConnectorSecrets)
      .where(
        and(
          eq(userConnectorSecrets.userId, session.userId),
          eq(userConnectorSecrets.connectorId, connectorId)
        )
      );
  }

  return NextResponse.json({ ok: true });
}
