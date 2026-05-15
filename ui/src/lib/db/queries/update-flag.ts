/**
 * Update Flag Queries
 *
 * Persists a flag in system_settings before UI self-update so the page
 * can detect the update completed after the container restarts.
 *
 * Key: "ui_update_pending"
 * Value: { pending: true, triggeredAt: ISO string } | null
 */

import { db, ensureSchema } from "@/db";
import { systemSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

interface UpdateFlag {
  pending: boolean;
  triggeredAt: string;
}

export async function getUpdateFlag(): Promise<UpdateFlag | null> {
  await ensureSchema();
  const [row] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "ui_update_pending"));
  const val = row?.value as UpdateFlag | null;
  return val?.pending ? val : null;
}

export async function setUpdateFlag(): Promise<void> {
  await ensureSchema();
  const value: UpdateFlag = {
    pending: true,
    triggeredAt: new Date().toISOString(),
  };

  const [existing] = await db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, "ui_update_pending"));

  if (existing) {
    await db
      .update(systemSettings)
      .set({ value, updatedAt: new Date() })
      .where(eq(systemSettings.key, "ui_update_pending"));
  } else {
    await db
      .insert(systemSettings)
      .values({ key: "ui_update_pending", value });
  }
}

export async function clearUpdateFlag(): Promise<void> {
  await ensureSchema();
  await db
    .delete(systemSettings)
    .where(eq(systemSettings.key, "ui_update_pending"));
}
