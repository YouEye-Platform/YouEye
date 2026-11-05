/**
 * User Assets Queries
 *
 * CRUD operations for user-uploaded files (icons, avatars).
 */

import { db, ensureSchema } from "@/db";
import { userAssets } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function createUserAsset(data: {
  userId: string;
  assetType: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
}) {
  await ensureSchema();
  const [asset] = await db.insert(userAssets).values(data).returning();
  return asset;
}

export async function getUserAssets(userId: string, assetType?: string) {
  await ensureSchema();
  if (assetType) {
    return db
      .select()
      .from(userAssets)
      .where(
        and(eq(userAssets.userId, userId), eq(userAssets.assetType, assetType))
      );
  }
  return db.select().from(userAssets).where(eq(userAssets.userId, userId));
}

export async function getAssetById(assetId: string) {
  await ensureSchema();
  const [asset] = await db
    .select()
    .from(userAssets)
    .where(eq(userAssets.id, assetId));
  return asset ?? null;
}

export async function deleteUserAsset(assetId: string, userId: string) {
  await ensureSchema();
  const [deleted] = await db
    .delete(userAssets)
    .where(and(eq(userAssets.id, assetId), eq(userAssets.userId, userId)))
    .returning();
  return deleted ?? null;
}
