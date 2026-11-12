// Isolated PostgreSQL fixture. Never writes to the application's public schema.
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../src/db/schema';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('An explicitly selected test PostgreSQL connection is required');
export const namespace = `timeline_test_${crypto.randomUUID().replaceAll('-', '')}`;
const admin = postgres(url, { max: 1, onnotice: () => {} });
export const sql = postgres(url, { connection: { search_path: namespace, application_name: namespace }, onnotice: () => {} });
export const db = drizzle(sql, { schema });
let ready: Promise<void> | undefined;
export function ensureSchema() {
  return ready ||= (async () => {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    for (const table of ['users', 'system_settings', 'user_encryption_keys', 'pin_sessions', 'timeline_entries', 'pending_timeline_events']) {
      await admin.unsafe(`CREATE TABLE ${namespace}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
  })();
}
export async function cleanup() {
  await sql.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  await admin.end();
}
