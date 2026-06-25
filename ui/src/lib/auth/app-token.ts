/**
 * App Token Validation (Gateway Migration)
 *
 * Apps authenticate to YE-UI by presenting a Bearer token.
 * YE-UI validates by SHA-256 hashing the token and comparing
 * against the stored hash in the apps table. No shared crypto
 * secrets needed — Control Panel sends the hash at registration time.
 */

import { db, ensureSchema } from "@/db";
import { apps } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function validateAppToken(
  request: Request,
): Promise<{ appId: string } | null> {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");
  if (!token) return null;

  const hash = hashToken(token);

  await ensureSchema();
  const [app] = await db
    .select({ id: apps.id })
    .from(apps)
    .where(eq(apps.tokenHash, hash))
    .limit(1);

  if (!app) return null;
  return { appId: app.id };
}
