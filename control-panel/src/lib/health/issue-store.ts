import { platformCommand as psql } from '@/lib/postgres/platform';

const STORE_KEY = 'issue-registry-v1';

let schemaReady: Promise<void> | null = null;

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = psql(`
      CREATE TABLE IF NOT EXISTS health_registry_state (
        key text PRIMARY KEY,
        value jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `).then(() => undefined).catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  await schemaReady;
}

export async function readHealthRegistry<T>(): Promise<T | null> {
  await ensureSchema();
  const output = await psql(`SELECT value::text FROM health_registry_state WHERE key = ${sql(STORE_KEY)}`);
  if (!output) return null;
  return JSON.parse(output) as T;
}

export async function writeHealthRegistry<T>(value: T): Promise<void> {
  await ensureSchema();
  const payload = JSON.stringify(value);
  await psql(`
    INSERT INTO health_registry_state (key, value, updated_at)
    VALUES (${sql(STORE_KEY)}, ${sql(payload)}::jsonb, now())
    ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
  `);
}
