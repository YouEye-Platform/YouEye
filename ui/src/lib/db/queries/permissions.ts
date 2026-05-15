/**
 * Permission Queries
 *
 * CRUD and check operations for app permissions.
 * Default deny: everything blocked unless explicitly granted.
 */

import { db, ensureSchema } from "@/db";
import { appPermissions, permissionAudit } from "@/db/schema";
import { eq, and, desc } from "drizzle-orm";

/** Check if an app has a specific permission for a user */
export async function checkPermission(
  userId: string,
  appId: string,
  permission: string
): Promise<boolean> {
  await ensureSchema();

  const [row] = await db
    .select({ granted: appPermissions.granted })
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId),
        eq(appPermissions.permission, permission)
      )
    )
    .limit(1);

  // Log the check
  await logPermissionAction(userId, appId, permission, "checked", "system");

  return row?.granted ?? false;
}

/** Grant a permission to an app */
export async function grantPermission(
  userId: string,
  appId: string,
  permission: string,
  grantType: "persistent" | "once" | "session" = "persistent",
  actor: string = "user"
): Promise<void> {
  await ensureSchema();

  // Upsert
  const existing = await db
    .select({ id: appPermissions.id })
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId),
        eq(appPermissions.permission, permission)
      )
    )
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(appPermissions)
      .set({ granted: true, grantType, grantedAt: new Date() })
      .where(eq(appPermissions.id, existing[0].id));
  } else {
    await db.insert(appPermissions).values({
      userId,
      appId,
      permission,
      granted: true,
      grantType,
    });
  }

  await logPermissionAction(userId, appId, permission, "granted", actor);
}

/** Revoke a permission from an app */
export async function revokePermission(
  userId: string,
  appId: string,
  permission: string,
  actor: string = "user"
): Promise<void> {
  await ensureSchema();

  await db
    .delete(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId),
        eq(appPermissions.permission, permission)
      )
    );

  await logPermissionAction(userId, appId, permission, "revoked", actor);
}

/** Get all permissions for an app */
export async function getAppPermissions(
  userId: string,
  appId: string
): Promise<
  Array<{
    permission: string;
    granted: boolean;
    grant_type: string | null;
    granted_at: Date | null;
  }>
> {
  await ensureSchema();

  const rows = await db
    .select()
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId)
      )
    );

  return rows.map((r) => ({
    permission: r.permission,
    granted: r.granted ?? false,
    grant_type: r.grantType,
    granted_at: r.grantedAt,
  }));
}

/** Get all permissions for a user (across all apps) */
export async function getAllUserPermissions(userId: string) {
  await ensureSchema();

  return db
    .select()
    .from(appPermissions)
    .where(eq(appPermissions.userId, userId))
    .orderBy(appPermissions.appId, appPermissions.permission);
}

/** Get permission audit log */
export async function getPermissionAuditLog(
  options: {
    userId?: string;
    appId?: string;
    limit?: number;
  } = {}
) {
  await ensureSchema();
  const { userId, appId, limit = 100 } = options;

  const conditions = [];
  if (userId) conditions.push(eq(permissionAudit.userId, userId));
  if (appId) conditions.push(eq(permissionAudit.appId, appId));

  const query = db
    .select()
    .from(permissionAudit)
    .orderBy(desc(permissionAudit.createdAt))
    .limit(limit);

  if (conditions.length > 0) {
    return query.where(and(...conditions));
  }

  return query;
}

/** Grant multiple permissions at once (for app installation) */
export async function grantBulkPermissions(
  userId: string,
  appId: string,
  permissions: string[],
  actor: string = "system"
): Promise<void> {
  for (const perm of permissions) {
    await grantPermission(userId, appId, perm, "persistent", actor);
  }
}

/** Consume a "once" permission (delete after use) */
export async function consumeOncePermission(
  userId: string,
  appId: string,
  permission: string
): Promise<boolean> {
  await ensureSchema();

  const [row] = await db
    .select()
    .from(appPermissions)
    .where(
      and(
        eq(appPermissions.userId, userId),
        eq(appPermissions.appId, appId),
        eq(appPermissions.permission, permission),
        eq(appPermissions.granted, true)
      )
    )
    .limit(1);

  if (!row) return false;

  if (row.grantType === "once") {
    await db.delete(appPermissions).where(eq(appPermissions.id, row.id));
    await logPermissionAction(
      userId,
      appId,
      permission,
      "consumed",
      "system"
    );
  }

  return true;
}

async function logPermissionAction(
  userId: string | undefined | null,
  appId: string,
  permission: string,
  action: string,
  actor: string
) {
  try {
    await db.insert(permissionAudit).values({
      userId: userId ?? undefined,
      appId,
      permission,
      action,
      actor,
    });
  } catch {
    // Don't fail on audit log errors
  }
}
