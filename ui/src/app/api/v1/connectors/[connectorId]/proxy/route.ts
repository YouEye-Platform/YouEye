/**
 * POST /api/v1/connectors/[connectorId]/proxy — Canvas SDK compatibility route
 *
 * The Canvas connector client calls: POST /api/v1/connectors/{connectorId}/proxy
 * with body: { endpoint, params, lang }
 *
 * This route extracts connectorId from the URL path and forwards to the
 * main proxy handler at /api/v1/connectors/proxy with connectorId in the body.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { db, ensureSchema } from "@/db";
import { userConnectorSecrets } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { fetchConnectorManifest } from "@/lib/connectors/registry";
import type { ConnectorManifest } from "@/lib/connectors/schema";

const CONNECTOR_RUNTIME_URL =
  process.env.CONNECTOR_RUNTIME_URL ?? "http://youeye-connectors.youeye:3001";

const ENCRYPTION_KEY = process.env.CONNECTOR_ENCRYPTION_KEY || "youeye-dev-key-32bytes-padding!";

async function decryptValue(encrypted: string, nonce: string): Promise<string> {
  try {
    const crypto = await import("node:crypto");
    const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "!").slice(0, 32));
    const iv = Buffer.from(nonce, "base64");
    const data = Buffer.from(encrypted, "base64");
    const authTag = data.subarray(data.length - 16);
    const ciphertext = data.subarray(0, data.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString("utf-8");
  } catch {
    return "";
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ connectorId: string }> }
) {
  const { connectorId } = await params;

  let userId: string | null = null;
  const session = await getSession();
  if (session) {
    userId = session.userId;
  } else {
    const serviceUser = await resolveServiceAuth(request);
    if (serviceUser) userId = serviceUser.id;
  }

  if (!userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    endpoint: string;
    params?: Record<string, string>;
    lang?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { endpoint, params: reqParams = {}, lang } = body;
  if (!endpoint) {
    return NextResponse.json({ error: "Missing endpoint" }, { status: 400 });
  }

  // Fetch manifest
  let manifest: ConnectorManifest | null = null;
  try {
    manifest = await fetchConnectorManifest(connectorId);
  } catch { /* fall through */ }

  if (!manifest) {
    return NextResponse.json(
      { ok: false, error: `Connector "${connectorId}" not found`, code: "NO_CONNECTOR" },
      { status: 404 }
    );
  }

  // Decrypt user credentials
  await ensureSchema();
  const secrets = await db
    .select()
    .from(userConnectorSecrets)
    .where(
      and(
        eq(userConnectorSecrets.userId, userId),
        eq(userConnectorSecrets.connectorId, connectorId)
      )
    );

  const endpointDef = manifest.api?.endpoints;
  const targetHosts = new Set<string>();
  if (endpointDef) {
    for (const ep of Object.values(endpointDef)) {
      try {
        const raw = ep.url?.replace(/\$\{[^}]+\}/g, "placeholder") ?? "";
        const u = new URL(raw);
        targetHosts.add(u.hostname);
      } catch { /* skip */ }
    }
  }

  const userConfig: Record<string, string> = {};
  for (const secret of secrets) {
    if (secret.boundHost && targetHosts.size > 0 && !targetHosts.has(secret.boundHost)) {
      continue;
    }
    const decrypted = await decryptValue(secret.encryptedValue, secret.nonce);
    if (decrypted) userConfig[secret.key] = decrypted;
  }

  // Forward to connector runtime
  try {
    const runtimeRes = await fetch(`${CONNECTOR_RUNTIME_URL}/proxy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YouEye-App": request.headers.get("x-youeye-app") || "",
        "X-YouEye-User": userId,
      },
      body: JSON.stringify({
        connectorId,
        endpoint,
        params: reqParams,
        lang,
        userConfig,
        manifest,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const result = await runtimeRes.json();
    return NextResponse.json(result, { status: runtimeRes.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: `Connector runtime error: ${message}`, code: "RUNTIME_ERROR" },
      { status: 502 }
    );
  }
}
