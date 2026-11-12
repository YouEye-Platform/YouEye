import { db, ensureSchema } from "@/db";
import { sql } from "drizzle-orm";
export type TimelineTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** One cross-process boundary for collection changes, ingestion and key rotation. */
export async function withTimelineUserLock<T>(userId: string, work: (tx: TimelineTransaction) => Promise<T>): Promise<T> {
  await ensureSchema();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"youeye:timeline:" + userId}, 0))`);
    return work(tx);
  });
}
