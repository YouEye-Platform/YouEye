/**
 * App Token Validation (Gateway Migration)
 *
 * Apps authenticate to YE-UI by presenting a Bearer token.
 * YE-UI validates by SHA-256 hashing the token and comparing
 * against the current installation projection and readiness. No shared crypto
 * secret is needed — Control Panel publishes secret-free lifecycle metadata.
 */

import { db, ensureSchema } from "@/db";
import { apps, appServiceCredentials } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateRegisteredAppBearer } from "./app-bearer";
export { hashToken } from "./app-bearer";

export async function validateAppToken(
  request: Request,
  purpose: 'service' | 'probe' = 'service',
): Promise<{ appId: string } | null> {
  return validateRegisteredAppBearer(request.headers, async hash => {
    await ensureSchema();
    return db
      .select({ appId: apps.id, enabled: apps.enabled, projection: appServiceCredentials.projection, ready: appServiceCredentials.ready })
      .from(appServiceCredentials)
      .innerJoin(apps, eq(apps.id, appServiceCredentials.appId))
      .where(eq(appServiceCredentials.verifierHash, hash))
      .limit(2);
  }, purpose);
}
