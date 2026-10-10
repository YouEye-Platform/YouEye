/**
 * App service authentication: current installation credential and exact app
 * identity precede stable acting-user lookup. Missing verifier state denies.
 * Service context cannot authorize browser/admin-only operations.
 */
import type { NextRequest } from "next/server";
import { db, ensureSchema } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { validateAppToken } from "./app-token";
import { evaluateLocalAdmission } from '@/lib/admission/store';
import { resolveAppServiceUser } from "./service-request";

export async function resolveServiceAuth(request: NextRequest) {
  return resolveAppServiceUser(
    request.headers,
    () => validateAppToken(request),
    async stableId => {
      await ensureSchema();
      const fields = {
        id: users.id, identityId: users.identityId, username: users.username,
        name: users.name, email: users.email,
      };
      const [mapped] = await db.select(fields).from(users)
        .where(eq(users.identityId, stableId)).limit(1);
      if (mapped) return mapped;
      // Explicit platform UUID mapping, never display names/email/group labels.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(stableId)) return null;
      const [user] = await db.select(fields).from(users)
        .where(eq(users.id, stableId)).limit(1);
      return user ?? null;
    },
    (appId, identityId) => evaluateLocalAdmission(appId, identityId).allowed,
  );
}
