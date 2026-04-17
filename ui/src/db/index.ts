/**
 * Database Client
 *
 * Creates a single shared database connection using the `postgres` driver
 * and Drizzle ORM. The DATABASE_URL environment variable must be set.
 *
 * Includes auto-migration: tables are created on first DB access if they
 * don't exist. This makes YE-UI self-healing — it won't fail if Spine's
 * schema init didn't run or failed silently.
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

const queryClient = postgres(connectionString);

export const db = drizzle(queryClient, { schema });

let schemaReady = false;

/**
 * Ensure all required tables exist. Safe to call multiple times —
 * uses CREATE TABLE IF NOT EXISTS and a singleton guard.
 */
export async function ensureSchema() {
  if (schemaReady) return;

  try {
    await queryClient`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        authentik_id TEXT UNIQUE,
        username TEXT UNIQUE,
        name TEXT,
        email TEXT UNIQUE,
        image TEXT,
        is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    // Add new user identity columns (safe on existing installs)
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT`;
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT`;
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT`;
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT`;
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS user_origin TEXT`;
    await queryClient`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN DEFAULT FALSE`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS widgets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_id TEXT,
        widget_type TEXT NOT NULL,
        position_x REAL NOT NULL DEFAULT 50,
        position_y REAL NOT NULL DEFAULT 50,
        width REAL NOT NULL DEFAULT 30,
        height REAL NOT NULL DEFAULT 10,
        settings JSONB DEFAULT '{}',
        "order" INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT,
        container_url TEXT,
        subdomain TEXT,
        icon TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        status TEXT DEFAULT 'unknown',
        manifest JSONB DEFAULT '{}',
        display_order INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    // C1: App gateway migration — token hash for app-to-UI auth
    await queryClient`ALTER TABLE apps ADD COLUMN IF NOT EXISTS token_hash TEXT`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_settings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        settings JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value JSONB,
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_app_config (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_id TEXT NOT NULL,
        custom_name TEXT,
        custom_icon_url TEXT,
        visible BOOLEAN DEFAULT TRUE,
        display_order INTEGER DEFAULT 0,
        section_id TEXT,
        UNIQUE(user_id, app_id)
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_drawer_sections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        section_id TEXT NOT NULL,
        name TEXT NOT NULL,
        display_order INTEGER DEFAULT 0,
        collapsed BOOLEAN DEFAULT FALSE,
        UNIQUE(user_id, section_id)
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type TEXT NOT NULL DEFAULT 'info',
        title TEXT NOT NULL,
        message TEXT,
        app_id TEXT,
        action JSONB,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE INDEX IF NOT EXISTS idx_notif_user_unread
        ON notifications(user_id, read) WHERE read = false`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_assets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        asset_type TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        storage_path TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS timeline_entries (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        collection TEXT NOT NULL,
        encrypted_blob TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE INDEX IF NOT EXISTS idx_timeline_user_collection
        ON timeline_entries(user_id, collection)`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_encryption_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        salt TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        iterations INTEGER NOT NULL DEFAULT 600000,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS pin_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        encrypted_derived_key TEXT NOT NULL,
        session_nonce TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS app_permissions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        app_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        granted BOOLEAN DEFAULT FALSE,
        granted_at TIMESTAMP DEFAULT NOW(),
        grant_type TEXT DEFAULT 'persistent',
        UNIQUE(user_id, app_id, permission)
      )`;

    await queryClient`
      CREATE INDEX IF NOT EXISTS idx_perm_user_app
        ON app_permissions(user_id, app_id)`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS permission_audit (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        app_id TEXT NOT NULL,
        permission TEXT NOT NULL,
        action TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS webhook_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscriber_app_id TEXT NOT NULL,
        event TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS inter_app_log (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID,
        from_app_id TEXT NOT NULL,
        to_app_id TEXT NOT NULL,
        request_type TEXT NOT NULL,
        success BOOLEAN DEFAULT FALSE,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS themes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        colors JSONB NOT NULL,
        is_preset BOOLEAN DEFAULT FALSE,
        created_by UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_theme_preferences (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        theme_id UUID NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
        app_overrides JSONB DEFAULT '{}',
        updated_at TIMESTAMP DEFAULT NOW()
      )`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_connectors (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        capability TEXT NOT NULL,
        consumer_app TEXT,
        priority INTEGER DEFAULT 0,
        enabled BOOLEAN DEFAULT TRUE,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, connector_id, consumer_app)
      )`;

    await queryClient`
      CREATE INDEX IF NOT EXISTS idx_user_connectors_capability
        ON user_connectors(user_id, capability)`;

    await queryClient`
      CREATE TABLE IF NOT EXISTS user_connector_secrets (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        connector_id TEXT NOT NULL,
        key TEXT NOT NULL,
        encrypted_value TEXT NOT NULL,
        nonce TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, connector_id, key)
      )`;

    // Seed preset themes if the themes table is empty
    await seedPresetThemes();

    schemaReady = true;
    console.log("Database schema verified");
  } catch (e) {
    console.error("Schema initialization failed:", e);
  }
}

/**
 * Seed the 8 built-in preset themes if none exist yet.
 * Uses OKLCH color values matching shadcn/ui v4 color system.
 */
async function seedPresetThemes() {
  const [countRow] = await queryClient`SELECT count(*)::int as c FROM themes WHERE is_preset = true`;
  if (countRow.c > 0) return;

  const { PRESET_THEMES } = await import("@/lib/themes/presets");
  for (const preset of PRESET_THEMES) {
    await queryClient`
      INSERT INTO themes (name, colors, is_preset)
      VALUES (${preset.name}, ${JSON.stringify(preset.colors)}::jsonb, true)
    `;
  }
  console.log(`[themes] Seeded ${PRESET_THEMES.length} preset themes`);
}
