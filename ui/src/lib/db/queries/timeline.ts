/**
 * Timeline Queries
 *
 * CRUD for timeline entries with encryption/decryption.
 * All entry content is encrypted at rest using AES-256-GCM.
 */

import { db, ensureSchema } from "@/db";
import { timelineEntries, pendingTimelineEvents } from "@/db/schema";
import { eq, and, desc, asc } from "drizzle-orm";
import { encrypt, decrypt, hybridEncrypt, hybridDecrypt } from "@/lib/crypto/encryption";

/** The plaintext content stored inside encrypted blobs */
export interface TimelineEntryData {
  app_id: string;
  entry_type: string;
  title: string;
  timestamp: string; // ISO 8601
  /** Lean URL path on the source app for rendering a rich embed card.
   *  Example: "/embed/timeline/movie-viewed?id=550&type=movie"
   *  UI constructs full URL: https://{app}.{domain}{embed_path}
   *  If the app is unavailable, falls back to rendering from `data`. */
  embed_path?: string;
  info_card?: {
    card_type: string;
    endpoint: string;
  };
  tags: Record<string, unknown>;
  /** Structured entry content — the real timeline data.
   *  Standard fields apps SHOULD populate:
   *    description?: string   — text snippet / overview
   *    thumbnail_url?: string — poster, screenshot, favicon
   *    url?: string           — original external URL
   *  Plus any app-specific fields (tmdb_id, rating, query, etc.)
   *  This data is programmatically accessible (MCP, AI agents, search). */
  data: Record<string, unknown>;
  // Import-specific fields
  import_source?: string;
  original_id?: string;
  original_timestamp?: string;
}

/** A decrypted timeline entry for client consumption */
export interface DecryptedTimelineEntry {
  id: string;
  user_id: string;
  collection: string;
  created_at: Date | null;
  entry: TimelineEntryData;
}

/** Create a new encrypted timeline entry */
export async function createTimelineEntry(
  userId: string,
  collection: "history" | "future" | "imported",
  entryData: TimelineEntryData,
  encryptionKey: CryptoKey
): Promise<string> {
  await ensureSchema();

  const plaintext = JSON.stringify(entryData);
  const { ciphertext, nonce } = await encrypt(plaintext, encryptionKey);

  const [row] = await db
    .insert(timelineEntries)
    .values({
      userId,
      collection,
      encryptedBlob: ciphertext,
      nonce,
    })
    .returning({ id: timelineEntries.id });

  return row.id;
}

/** Create a new hybrid-encrypted timeline entry (RSA-wrapped per-entry AES key) */
export async function createHybridTimelineEntry(
  userId: string,
  collection: "history" | "future" | "imported",
  entryData: TimelineEntryData,
  publicKey: CryptoKey
): Promise<string> {
  await ensureSchema();

  const plaintext = JSON.stringify(entryData);
  const { ciphertext, nonce, wrappedKey } = await hybridEncrypt(plaintext, publicKey);

  const [row] = await db
    .insert(timelineEntries)
    .values({
      userId,
      collection,
      encryptedBlob: ciphertext,
      nonce,
      encryptionType: "hybrid",
      wrappedKey,
    })
    .returning({ id: timelineEntries.id });

  return row.id;
}

/** Read and decrypt timeline entries with optional filtering */
export async function getTimelineEntries(
  userId: string,
  encryptionKey: CryptoKey,
  options: {
    collection?: string;
    limit?: number;
    offset?: number;
    app?: string;
    entryType?: string;
    tag?: string; // "key:value" format
    from?: string; // ISO date
    to?: string; // ISO date
    sort?: "asc" | "desc";
    privateKey?: CryptoKey; // RSA private key for hybrid entries
  } = {}
): Promise<{ entries: DecryptedTimelineEntry[]; total: number }> {
  await ensureSchema();

  const {
    collection,
    limit = 50,
    offset = 0,
    app,
    entryType,
    tag,
    from,
    to,
    sort = "desc",
    privateKey,
  } = options;

  // Query all matching rows (filter by collection if specified)
  const conditions = [eq(timelineEntries.userId, userId)];
  if (collection) {
    conditions.push(eq(timelineEntries.collection, collection));
  }

  const rows = await db
    .select()
    .from(timelineEntries)
    .where(and(...conditions))
    .orderBy(
      sort === "asc"
        ? asc(timelineEntries.createdAt)
        : desc(timelineEntries.createdAt)
    );

  // Decrypt all entries (handle both PIN-encrypted and hybrid-encrypted)
  const decrypted: DecryptedTimelineEntry[] = [];

  for (const row of rows) {
    try {
      let plaintext: string;

      if (row.encryptionType === "hybrid" && row.wrappedKey) {
        // Hybrid entry: unwrap per-entry AES key with RSA private key
        if (!privateKey) continue; // Can't decrypt without private key
        plaintext = await hybridDecrypt(row.encryptedBlob, row.nonce, row.wrappedKey, privateKey);
      } else {
        // PIN-encrypted entry: decrypt directly with PIN-derived key
        plaintext = await decrypt(row.encryptedBlob, row.nonce, encryptionKey);
      }

      const entry: TimelineEntryData = JSON.parse(plaintext);
      decrypted.push({
        id: row.id,
        user_id: row.userId,
        collection: row.collection,
        created_at: row.createdAt,
        entry,
      });
    } catch {
      // Skip entries that fail to decrypt (corrupted or wrong key)
      continue;
    }
  }

  // Apply in-memory filters on decrypted data
  let filtered = decrypted;

  if (app) {
    filtered = filtered.filter((e) => e.entry.app_id === app);
  }

  if (entryType) {
    filtered = filtered.filter((e) => e.entry.entry_type === entryType);
  }

  if (tag) {
    const [tagKey, tagValue] = tag.split(":");
    filtered = filtered.filter((e) => {
      const val = e.entry.tags[tagKey];
      if (tagValue === undefined) return val !== undefined;
      return String(val) === tagValue;
    });
  }

  if (from) {
    const fromDate = new Date(from);
    filtered = filtered.filter(
      (e) => new Date(e.entry.timestamp) >= fromDate
    );
  }

  if (to) {
    const toDate = new Date(to);
    filtered = filtered.filter(
      (e) => new Date(e.entry.timestamp) <= toDate
    );
  }

  // Sort by entry timestamp (not DB timestamp)
  filtered.sort((a, b) => {
    const aTime = new Date(a.entry.timestamp).getTime();
    const bTime = new Date(b.entry.timestamp).getTime();
    return sort === "asc" ? aTime - bTime : bTime - aTime;
  });

  const total = filtered.length;

  // Paginate
  const paginated = filtered.slice(offset, offset + limit);

  return { entries: paginated, total };
}

/** Get a single timeline entry by ID */
export async function getTimelineEntry(
  entryId: string,
  userId: string,
  encryptionKey: CryptoKey,
  privateKey?: CryptoKey
): Promise<DecryptedTimelineEntry | null> {
  await ensureSchema();

  const [row] = await db
    .select()
    .from(timelineEntries)
    .where(
      and(eq(timelineEntries.id, entryId), eq(timelineEntries.userId, userId))
    )
    .limit(1);

  if (!row) return null;

  try {
    let plaintext: string;

    if (row.encryptionType === "hybrid" && row.wrappedKey) {
      if (!privateKey) return null;
      plaintext = await hybridDecrypt(row.encryptedBlob, row.nonce, row.wrappedKey, privateKey);
    } else {
      plaintext = await decrypt(row.encryptedBlob, row.nonce, encryptionKey);
    }

    const entry: TimelineEntryData = JSON.parse(plaintext);
    return {
      id: row.id,
      user_id: row.userId,
      collection: row.collection,
      created_at: row.createdAt,
      entry,
    };
  } catch {
    return null;
  }
}

/** Delete a timeline entry */
export async function deleteTimelineEntry(
  entryId: string,
  userId: string
): Promise<boolean> {
  await ensureSchema();

  const result = await db
    .delete(timelineEntries)
    .where(
      and(eq(timelineEntries.id, entryId), eq(timelineEntries.userId, userId))
    )
    .returning({ id: timelineEntries.id });

  return result.length > 0;
}

/** Update a future timeline entry (re-encrypt with new data) */
export async function updateTimelineEntry(
  entryId: string,
  userId: string,
  entryData: Partial<TimelineEntryData>,
  encryptionKey: CryptoKey,
  privateKey?: CryptoKey
): Promise<boolean> {
  await ensureSchema();

  // Get existing entry
  const existing = await getTimelineEntry(entryId, userId, encryptionKey, privateKey);
  if (!existing) return false;

  // Only future entries can be updated
  if (existing.collection !== "future") return false;

  // Merge data
  const merged: TimelineEntryData = {
    ...existing.entry,
    ...entryData,
    tags: { ...existing.entry.tags, ...(entryData.tags ?? {}) },
    data: { ...existing.entry.data, ...(entryData.data ?? {}) },
  };

  // Re-encrypt
  const plaintext = JSON.stringify(merged);
  const { ciphertext, nonce } = await encrypt(plaintext, encryptionKey);

  const result = await db
    .update(timelineEntries)
    .set({ encryptedBlob: ciphertext, nonce })
    .where(
      and(eq(timelineEntries.id, entryId), eq(timelineEntries.userId, userId))
    )
    .returning({ id: timelineEntries.id });

  return result.length > 0;
}

/** Get entry counts per collection for a user */
export async function getTimelineCounts(
  userId: string
): Promise<{ history: number; future: number; imported: number }> {
  await ensureSchema();

  const rows = await db
    .select({ collection: timelineEntries.collection })
    .from(timelineEntries)
    .where(eq(timelineEntries.userId, userId));

  const counts = { history: 0, future: 0, imported: 0 };
  for (const row of rows) {
    if (row.collection in counts) {
      counts[row.collection as keyof typeof counts]++;
    }
  }
  return counts;
}

// ============================================
// Pending Timeline Events (for app-generated events)
// ============================================

/** Queue a pending timeline event (unencrypted, to be encrypted on next PIN unlock) */
export async function queuePendingEvent(
  userId: string,
  appId: string,
  collection: string,
  payload: Record<string, unknown>
): Promise<string> {
  await ensureSchema();

  const [row] = await db
    .insert(pendingTimelineEvents)
    .values({
      userId,
      appId,
      collection,
      payload,
    })
    .returning({ id: pendingTimelineEvents.id });

  return row.id;
}

/** Get all pending events for a user */
export async function getPendingEvents(
  userId: string
): Promise<
  Array<{
    id: string;
    appId: string;
    collection: string;
    payload: Record<string, unknown>;
  }>
> {
  await ensureSchema();

  return db
    .select({
      id: pendingTimelineEvents.id,
      appId: pendingTimelineEvents.appId,
      collection: pendingTimelineEvents.collection,
      payload: pendingTimelineEvents.payload,
    })
    .from(pendingTimelineEvents)
    .where(eq(pendingTimelineEvents.userId, userId))
    .orderBy(asc(pendingTimelineEvents.createdAt));
}

/** Delete a pending event after it has been encrypted and moved */
export async function deletePendingEvent(eventId: string): Promise<void> {
  await ensureSchema();

  await db
    .delete(pendingTimelineEvents)
    .where(eq(pendingTimelineEvents.id, eventId));
}

/**
 * Process pending events: encrypt and move to timelineEntries.
 * Called when the user has an active PIN session and loads the timeline.
 */
export async function processPendingEvents(
  userId: string,
  encryptionKey: CryptoKey
): Promise<number> {
  const pending = await getPendingEvents(userId);
  if (pending.length === 0) return 0;

  let processed = 0;

  for (const event of pending) {
    try {
      const entryData: TimelineEntryData = {
        app_id: event.appId,
        entry_type: (event.payload.entry_type as string) ?? "unknown",
        title: (event.payload.title as string) ?? "Untitled",
        timestamp:
          (event.payload.timestamp as string) ?? new Date().toISOString(),
        embed_path: (event.payload.embed_path as string) ?? undefined,
        info_card: event.payload.info_card as
          | { card_type: string; endpoint: string }
          | undefined,
        tags: (event.payload.tags as Record<string, unknown>) ?? {},
        data: (event.payload.data as Record<string, unknown>) ?? {},
      };

      await createTimelineEntry(
        userId,
        event.collection as "history" | "future" | "imported",
        entryData,
        encryptionKey
      );

      await deletePendingEvent(event.id);
      processed++;
    } catch {
      // Skip events that fail to process — they'll be retried next time
      continue;
    }
  }

  return processed;
}
