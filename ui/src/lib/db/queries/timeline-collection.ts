import { db, ensureSchema } from "@/db";
import { pendingTimelineEvents, systemSettings, userEncryptionKeys, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { withTimelineUserLock, type TimelineTransaction } from "../timeline-lock";

const stateSchema = z.object({
  schema: z.literal("youeye.timeline-collection/1"),
  enabled: z.boolean(), revision: z.uuid(), requestId: z.uuid(),
  enabledAt: z.iso.datetime().nullable(), updatedAt: z.iso.datetime(),
  completed: z.boolean(),
}).strict().refine((state) => state.enabled === (state.enabledAt !== null));
export type TimelineCollectionState = {
  configured: boolean; enabled: boolean; revision: string | null; enabledAt: string | null;
};
const keyFor = (userId: string) => `timeline_collection:${userId}`;
export class TimelineCollectionError extends Error {
  constructor(public readonly code: "collection_off" | "collection_changed" | "key_required" | "state_unknown") { super(code); }
}
async function readState(userId: string, client: typeof db | TimelineTransaction) {
  const [row] = await client.select().from(systemSettings).where(eq(systemSettings.key, keyFor(userId)));
  if (!row) return null;
  const parsed = stateSchema.safeParse(row.value);
  if (!parsed.success) throw new TimelineCollectionError("state_unknown");
  return parsed.data;
}
function publicState(state: z.infer<typeof stateSchema> | null): TimelineCollectionState {
  return { configured: state !== null, enabled: state?.enabled ?? false, revision: state?.revision ?? null, enabledAt: state?.enabledAt ?? null };
}
export async function getTimelineCollection(userId: string): Promise<TimelineCollectionState> {
  await ensureSchema();
  return publicState(await readState(userId, db));
}

/** Completion and consent commit together; lost responses can be reconciled by GET. */
export async function setTimelineCollection(userId: string, input: {
  enabled: boolean; expected_revision: string | null; request_id: string; complete?: boolean;
}): Promise<TimelineCollectionState> {
  const value = z.object({
    enabled: z.boolean(), expected_revision: z.uuid().nullable(), request_id: z.uuid(), complete: z.boolean().optional(),
  }).strict().parse(input);
  return withTimelineUserLock(userId, async (tx) => {
    const current = await readState(userId, tx);
    if (current?.requestId === value.request_id) {
      if (current.enabled !== value.enabled || current.completed !== (value.complete === true)) throw new TimelineCollectionError("collection_changed");
      return publicState(current);
    }
    if ((current?.revision ?? null) !== value.expected_revision) throw new TimelineCollectionError("collection_changed");
    if (value.enabled) {
      const [key] = await tx.select().from(userEncryptionKeys).where(eq(userEncryptionKeys.userId, userId));
      if (!key?.publicKey || !key.encryptedPrivateKey || !key.privateKeyNonce) throw new TimelineCollectionError("key_required");
      try { await (await import("@/lib/crypto/encryption")).importPublicKey(key.publicKey); }
      catch { throw new TimelineCollectionError("key_required"); }
    }
    const now = new Date().toISOString();
    const next = {
      schema: "youeye.timeline-collection/1" as const, enabled: value.enabled,
      revision: crypto.randomUUID(), requestId: value.request_id, updatedAt: now,
      completed: value.complete === true,
      enabledAt: value.enabled ? (current?.enabled ? current.enabledAt : now) : null,
    };
    // A new collection interval never replays unsettled payloads from an old one.
    await tx.delete(pendingTimelineEvents).where(eq(pendingTimelineEvents.userId, userId));
    await tx.insert(systemSettings).values({ key: keyFor(userId), value: next }).onConflictDoUpdate({
      target: systemSettings.key, set: { value: next, updatedAt: new Date() },
    });
    if (value.complete) await tx.update(users).set({ onboardingCompleted: true, updatedAt: new Date() }).where(eq(users.id, userId));
    return publicState(next);
  });
}

/** Called under the same transaction lock immediately before payload persistence. */
export async function admitTimelineWrite(userId: string, revision: string | undefined, timestamp: string, tx: TimelineTransaction) {
  const state = await readState(userId, tx);
  if (!state?.enabled) throw new TimelineCollectionError("collection_off");
  if (!revision || revision !== state.revision) throw new TimelineCollectionError("collection_changed");
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || !state.enabledAt || time < Date.parse(state.enabledAt)) throw new TimelineCollectionError("collection_changed");
}
