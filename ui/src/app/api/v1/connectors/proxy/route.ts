/**
 * POST /api/v1/connectors/proxy — Forward connector proxy requests to the runtime.
 *
 * YE-UI is in the data path: it decrypts user credentials and forwards to
 * the connector runtime container. The runtime has NO database access and
 * NO secrets — it only executes upstream fetches + transforms.
 *
 * Body: { connectorId, endpoint, params, lang }
 * Auth: session cookie or X-YouEye-App + X-YouEye-User
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { db, ensureSchema } from "@/db";
import { userConnectorSecrets } from "@/db/schema";
import { eq, and } from "drizzle-orm";

const CONNECTOR_RUNTIME_URL =
  process.env.CONNECTOR_RUNTIME_URL ?? "http://youeye-connectors.youeye:3001";
const CP_API_URL =
  process.env.CP_API_URL ?? "http://youeye-control.youeye:3000/api";

// AES-256-GCM decryption for stored credentials
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

export async function POST(request: NextRequest) {
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
    connectorId: string;
    endpoint: string;
    params?: Record<string, string>;
    lang?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { connectorId, endpoint, params = {}, lang } = body;
  if (!connectorId || !endpoint) {
    return NextResponse.json({ error: "Missing connectorId or endpoint" }, { status: 400 });
  }

  // Fetch manifest from CP registry (it has the catalog cache)
  let manifest: Record<string, unknown> | null = null;
  try {
    const res = await fetch(`${CP_API_URL}/connectors/${connectorId}/manifest`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = await res.json();
      manifest = data.manifest;
    }
  } catch { /* fall through */ }

  // Fallback: try connector runtime directly
  if (!manifest) {
    try {
      const res = await fetch(`${CONNECTOR_RUNTIME_URL}/manifests?id=${connectorId}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        const data = await res.json();
        manifest = data.manifest;
      }
    } catch { /* fall through */ }
  }

  if (!manifest) {
    return NextResponse.json(
      { ok: false, error: `Connector "${connectorId}" not found`, code: "NO_CONNECTOR" },
      { status: 404 }
    );
  }

  // Decrypt user credentials for this connector
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

  const userConfig: Record<string, string> = {};
  for (const secret of secrets) {
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
        params,
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
