// Explicit disposable PostgreSQL schema; never changes application rows.
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../src/db/schema";

if (!process.env.DATABASE_URL) throw new Error("An explicit test PostgreSQL connection is required");
const namespace = `widgets_test_${crypto.randomUUID().replaceAll("-", "")}`;
const admin = postgres(process.env.DATABASE_URL, { max: 1, onnotice: () => {} });
export const client = postgres(process.env.DATABASE_URL, {
  connection: { search_path: namespace, application_name: namespace },
  onnotice: () => {},
});
export const db = drizzle(client, { schema });
let ready: Promise<void> | undefined;
export function ensureSchema() {
  return ready ||= (async () => {
    await admin.unsafe(`CREATE SCHEMA ${namespace}`);
    await admin.unsafe(`CREATE TABLE ${namespace}.widgets (LIKE public.widgets INCLUDING ALL)`);
    await admin.unsafe(`ALTER TABLE ${namespace}.widgets ADD CHECK (width > 0)`);
  })();
}
export async function cleanup() {
  await client.end();
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${namespace} CASCADE`);
  await admin.end();
}
