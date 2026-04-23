/**
 * Database Schema
 *
 * Defines all PostgreSQL tables for YouEye-UI using Drizzle ORM.
 * Tables are organized into sections:
 * - Users: Authentication and user profiles
 * - Widgets: Homepage widget layout per user
 * - Apps: Registry of installed sub-applications (Phase 2)
 * - Settings: User and system preferences
 */

import {
  pgTable,
  text,
  timestamp,
  uuid,
  integer,
  real,
  boolean,
  jsonb,
} from "drizzle-orm/pg-core";

// ============================================
// Users
// ============================================

/**
 * Users table — stores authenticated users.
 * Users are created on first SSO login from Authentik.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Authentik subject ID (unique per user in Authentik) */
  authentikId: text("authentik_id").unique(),
  /** Username from Authentik */
  username: text("username").unique(),
  /** Display name */
  name: text("name"),
  /** First name (synced from Authentik given_name claim) */
  firstName: text("first_name"),
  /** Last name (synced from Authentik family_name claim) */
  lastName: text("last_name"),
  /** User bio (free text) */
  bio: text("bio"),
  /** User timezone (IANA format, e.g. "America/New_York") */
  timezone: text("timezone"),
  /** Federation origin placeholder — always null for now */
  userOrigin: text("user_origin"),
  /** Email address */
  email: text("email").unique(),
  /** Profile image URL */
  image: text("image"),
  /** Whether user has admin privileges */
  isAdmin: boolean("is_admin").default(false),
  /** Whether user has completed the first-login onboarding flow */
  onboardingCompleted: boolean("onboarding_completed").default(false),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Widgets
// ============================================

/**
 * Widgets table — stores each user's homepage widget layout.
 * Positions use percentage values (0-100) for responsive design.
 */
export const widgets = pgTable("widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Owner of this widget instance */
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** App that provides this widget (null for built-in widgets) */
  appId: text("app_id"),
  /** Widget type identifier (e.g., "search", "clock", "greeting") */
  widgetType: text("widget_type").notNull(),
  /** X position as percentage (0-100, center point) */
  positionX: real("position_x").notNull().default(50),
  /** Y position as percentage (0-100, center point) */
  positionY: real("position_y").notNull().default(50),
  /** Width as percentage (0-100) */
  width: real("width").notNull().default(30),
  /** Height as percentage (0-100) */
  height: real("height").notNull().default(10),
  /** Widget-specific settings (JSON) */
  settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
  /** Display order for overlapping widgets */
  order: integer("order").default(0),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Apps (Phase 2 — prepared but not used yet)
// ============================================

/**
 * Apps table — registry of installed sub-applications.
 * Each app runs in its own container and gets a subdomain.
 */
export const apps = pgTable("apps", {
  /** Unique app identifier (e.g., "notes", "cinema") */
  id: text("id").primaryKey(),
  /** Display name */
  name: text("name").notNull(),
  /** App version */
  version: text("version"),
  /** Internal container URL */
  containerUrl: text("container_url"),
  /** Subdomain for this app (e.g., "notes" → notes.skibidi.wtf) */
  subdomain: text("subdomain"),
  /** Lucide icon name */
  icon: text("icon"),
  /** Whether app is enabled */
  enabled: boolean("enabled").default(true),
  /** Health status: healthy, unhealthy, unknown */
  status: text("status").default("unknown"),
  /** App manifest data (widgets, permissions, etc.) */
  manifest: jsonb("manifest").$type<Record<string, unknown>>().default({}),
  /** Display order in app drawer */
  displayOrder: integer("display_order").default(0),
  /** SHA-256 hash of the app's gateway token (for app-to-UI API auth) */
  tokenHash: text("token_hash"),
  /** SSO entry URL path (e.g. /sso/OID/start/authentik) — appended to subdomain URL for auto-SSO login */
  ssoEntryUrl: text("sso_entry_url"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

// ============================================
// User App Configuration
// ============================================

/**
 * Per-user app customization — rename, icon, order, visibility.
 * Each user can independently customize their app drawer.
 */
export const userAppConfig = pgTable("user_app_config", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** App ID from the apps table */
  appId: text("app_id").notNull(),
  /** User's custom display name for this app */
  customName: text("custom_name"),
  /** URL to user-uploaded custom icon */
  customIconUrl: text("custom_icon_url"),
  /** Whether app is visible in user's drawer */
  visible: boolean("visible").default(true),
  /** User's preferred display order */
  displayOrder: integer("display_order").default(0),
  /** Section this app belongs to (references user_drawer_sections) */
  sectionId: text("section_id"),
});

/**
 * User-created app drawer sections/folders.
 * Users can organize apps into custom categories.
 */
export const userDrawerSections = pgTable("user_drawer_sections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Unique section identifier per user */
  sectionId: text("section_id").notNull(),
  /** Display name */
  name: text("name").notNull(),
  /** Display order */
  displayOrder: integer("display_order").default(0),
  /** Whether section is collapsed in the drawer */
  collapsed: boolean("collapsed").default(false),
});

// ============================================
// Notifications
// ============================================

/**
 * User notifications — transient alerts requiring attention.
 * Sources: system, native apps, admin announcements.
 */
export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Type: info, success, warning, error */
  type: text("type").notNull().default("info"),
  /** Notification title */
  title: text("title").notNull(),
  /** Optional detailed message */
  message: text("message"),
  /** Source app ID (null for system notifications) */
  appId: text("app_id"),
  /** Optional action (e.g., { type: "navigate", url: "/settings" }) */
  action: jsonb("action").$type<Record<string, unknown>>(),
  /** Whether user has read it */
  read: boolean("read").default(false),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// User Assets
// ============================================

/**
 * User-uploaded files — custom icons, avatars, etc.
 * Files stored on disk, metadata tracked here.
 */
export const userAssets = pgTable("user_assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Asset type: app-icon, avatar, logo, favicon */
  assetType: text("asset_type").notNull(),
  /** Original filename */
  filename: text("filename").notNull(),
  /** MIME type */
  mimeType: text("mime_type").notNull(),
  /** File size in bytes */
  sizeBytes: integer("size_bytes").notNull(),
  /** Path to stored file on disk */
  storagePath: text("storage_path").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Timeline (Encrypted)
// ============================================

/**
 * Timeline entries — encrypted blob storage.
 * All meaningful content is encrypted in the blob. Only collection
 * and user_id remain unencrypted for query routing.
 */
export const timelineEntries = pgTable("timeline_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Which collection: history, future, imported */
  collection: text("collection").notNull(),
  /** AES-256-GCM encrypted blob (base64) containing all entry data */
  encryptedBlob: text("encrypted_blob").notNull(),
  /** GCM nonce/IV (base64) */
  nonce: text("nonce").notNull(),
  /** DB-level timestamp (NOT the event timestamp, which is encrypted) */
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

/**
 * Pending timeline events — temporary unencrypted storage.
 * When apps emit timeline events and the user has no active PIN session,
 * events are queued here. On next timeline load with active PIN,
 * pending events are encrypted and moved to timelineEntries.
 */
export const pendingTimelineEvents = pgTable("pending_timeline_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Which collection: history, future */
  collection: text("collection").notNull().default("history"),
  /** Source app ID */
  appId: text("app_id").notNull(),
  /** Unencrypted event payload (JSON) */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// PIN & Encryption Keys
// ============================================

/**
 * User encryption keys — stores salt and verification hash.
 * The actual encryption key is derived from PIN + salt via PBKDF2
 * and only lives in memory during an active PIN session.
 */
export const userEncryptionKeys = pgTable("user_encryption_keys", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** PBKDF2 salt (base64) */
  salt: text("salt").notNull(),
  /** Hash of derived key for PIN verification (base64) */
  keyHash: text("key_hash").notNull(),
  /** PBKDF2 iterations used */
  iterations: integer("iterations").notNull().default(600000),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

/**
 * PIN sessions — tracks active decryption sessions.
 * The derived key is stored encrypted in the session row,
 * protected by a session-specific random key stored only in the cookie.
 */
export const pinSessions = pgTable("pin_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Session-encrypted derived key (base64) */
  encryptedDerivedKey: text("encrypted_derived_key").notNull(),
  /** Nonce for the session encryption (base64) */
  sessionNonce: text("session_nonce").notNull(),
  /** When this session expires */
  expiresAt: timestamp("expires_at", { mode: "date" }).notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Permissions
// ============================================

/**
 * App permissions — per-user allow/deny for each app resource.
 * Default deny: everything blocked unless explicitly granted.
 */
export const appPermissions = pgTable("app_permissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** App that was granted the permission */
  appId: text("app_id").notNull(),
  /** Permission string (e.g., "timeline:write") */
  permission: text("permission").notNull(),
  /** Whether permission is granted */
  granted: boolean("granted").default(false),
  /** When permission was granted */
  grantedAt: timestamp("granted_at", { mode: "date" }).defaultNow(),
  /** Grant type: persistent, once, session */
  grantType: text("grant_type").default("persistent"),
});

/**
 * Permission audit log — tracks all permission changes.
 */
export const permissionAudit = pgTable("permission_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  /** App involved */
  appId: text("app_id").notNull(),
  /** Permission string */
  permission: text("permission").notNull(),
  /** Action: granted, revoked, denied, checked */
  action: text("action").notNull(),
  /** Who performed the action: user, admin, system */
  actor: text("actor").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Inter-App Communication
// ============================================

/**
 * Webhook subscriptions — apps subscribe to events from other apps.
 */
export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** App subscribing to the event */
  subscriberAppId: text("subscriber_app_id").notNull(),
  /** Event pattern (e.g., "photos:new-photo") */
  event: text("event").notNull(),
  /** Endpoint to deliver webhook to */
  endpoint: text("endpoint").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

/**
 * Inter-app request log — tracks all inter-app communication.
 */
export const interAppLog = pgTable("inter_app_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id"),
  /** App that made the request */
  fromAppId: text("from_app_id").notNull(),
  /** App that received the request */
  toAppId: text("to_app_id").notNull(),
  /** Request type */
  requestType: text("request_type").notNull(),
  /** Whether request succeeded */
  success: boolean("success").default(false),
  /** Error message if failed */
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Gateway Request Log
// ============================================

/**
 * Gateway request log — tracks all inter-app API calls through the gateway.
 * Rolling window: oldest entries auto-deleted when count exceeds 10,000.
 */
export const gatewayRequests = pgTable("gateway_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** App that made the request */
  appSlug: text("app_slug").notNull(),
  /** API endpoint path */
  endpoint: text("endpoint").notNull(),
  /** HTTP method */
  method: text("method").notNull(),
  /** Response status code */
  statusCode: integer("status_code").notNull(),
  /** Request duration in milliseconds */
  durationMs: integer("duration_ms").notNull(),
  /** Whether the request was rate limited */
  rateLimited: boolean("rate_limited").default(false),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Connectors
// ============================================

/**
 * User connector preferences — which connector each user selects for each capability.
 * Users can have different connectors per consuming app or a default for all apps.
 */
export const userConnectors = pgTable("user_connectors", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Connector ID from the catalog (e.g. "searxng-search") */
  connectorId: text("connector_id").notNull(),
  /** Capability this connector provides (e.g. "search-engine") */
  capability: text("capability").notNull(),
  /** Which app uses this connector (null = default for all apps) */
  consumerApp: text("consumer_app"),
  /** Priority when multiple connectors for same capability (lower = preferred) */
  priority: integer("priority").default(0),
  enabled: boolean("enabled").default(true),
  /** Whether this choice persists across sessions (false = session-only) */
  persistent: boolean("persistent").default(true),
  /** User-specific connector config (non-secret settings) */
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

/**
 * User connector secrets — encrypted API keys and credentials per connector.
 * Values encrypted with AES-256-GCM, key derived from system secret.
 */
export const userConnectorSecrets = pgTable("user_connector_secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Connector ID */
  connectorId: text("connector_id").notNull(),
  /** Config field name (e.g. "api_key") */
  key: text("key").notNull(),
  /** Encrypted value (AES-256-GCM, base64) */
  encryptedValue: text("encrypted_value").notNull(),
  /** Encryption nonce (base64) */
  nonce: text("nonce").notNull(),
  /** Host this credential is bound to — prevents forwarding to wrong host */
  boundHost: text("bound_host"),
  /** Auth provider that manages this credential (null = manually entered) */
  authProviderId: uuid("auth_provider_id"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Auth Providers (shared credentials across connectors)
// ============================================

/**
 * Auth providers — admin-configured credential sources.
 * A provider (e.g., "Google", "Spotify") can serve credentials to
 * multiple connectors. Users authenticate once; all connectors
 * referencing that provider get tokens automatically.
 */
export const authProviders = pgTable("auth_providers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Provider slug (e.g., "google", "spotify", "microsoft") */
  slug: text("slug").notNull().unique(),
  /** Display name (e.g., "Google", "Spotify") */
  name: text("name").notNull(),
  /** Provider type: oauth2, api-key-shared */
  type: text("type").notNull(),
  /** OAuth2 client ID (admin-configured) */
  clientId: text("client_id"),
  /** OAuth2 client secret (encrypted) */
  clientSecretEncrypted: text("client_secret_encrypted"),
  /** Encryption nonce for client secret */
  clientSecretNonce: text("client_secret_nonce"),
  /** OAuth2 authorization URL */
  authUrl: text("auth_url"),
  /** OAuth2 token URL */
  tokenUrl: text("token_url"),
  /** Space-separated default scopes */
  defaultScopes: text("default_scopes"),
  /** Whether this provider is enabled */
  enabled: boolean("enabled").default(true),
  /** Additional provider config (e.g., PKCE settings) */
  config: jsonb("config").$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

/**
 * User auth provider tokens — per-user credential storage for auth providers.
 * Stores OAuth2 tokens or shared API keys from a provider.
 * Multiple connectors can reference the same provider token.
 */
export const userAuthTokens = pgTable("user_auth_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Auth provider this token belongs to */
  providerId: uuid("provider_id")
    .notNull()
    .references(() => authProviders.id, { onDelete: "cascade" }),
  /** Encrypted access token */
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  /** Nonce for access token */
  accessTokenNonce: text("access_token_nonce").notNull(),
  /** Encrypted refresh token (nullable for API keys / non-refreshable tokens) */
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  /** Nonce for refresh token */
  refreshTokenNonce: text("refresh_token_nonce"),
  /** Granted scopes (space-separated) */
  scopes: text("scopes"),
  /** When the access token expires */
  expiresAt: timestamp("expires_at", { mode: "date" }),
  /** Host(s) this token is bound to (comma-separated) */
  boundHosts: text("bound_hosts"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Connector Defaults (admin-set system-wide)
// ============================================

/**
 * Admin-configured default connector per capability.
 * New users get these pre-applied. Shared API keys stored encrypted.
 */
export const connectorDefaults = pgTable("connector_defaults", {
  /** Capability name (e.g. "search-engine") — primary key */
  capability: text("capability").primaryKey(),
  /** Default connector ID from catalog */
  connectorId: text("connector_id").notNull(),
  /** Optional shared encrypted API key for this connector */
  sharedKeyEncrypted: text("shared_key_encrypted"),
  /** Nonce for shared key */
  sharedKeyNonce: text("shared_key_nonce"),
  /** Admin who set this default */
  setBy: uuid("set_by").references(() => users.id, { onDelete: "set null" }),
  setAt: timestamp("set_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Settings
// ============================================

/**
 * User settings — per-user preferences stored as JSON.
 */
export const userSettings = pgTable("user_settings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** User preferences as JSON */
  settings: jsonb("settings")
    .$type<Record<string, unknown>>()
    .default({}),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

/**
 * System settings — global configuration for the YouEye instance.
 * Key-value store for domain, instance name, etc.
 */
export const systemSettings = pgTable("system_settings", {
  /** Setting key (e.g., "domain", "instance_name") */
  key: text("key").primaryKey(),
  /** Setting value as JSON */
  value: jsonb("value").$type<unknown>(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

// ============================================
// WordArt Presets
// ============================================

/**
 * Saved WordArt designs — users can save/load named presets.
 * scope='user': private to the owner. scope='server': admin-created, visible to all.
 * Active WordArt is always a COPY in userSettings/systemSettings — deleting
 * a preset never breaks anyone's active style.
 */
export const wordartPresets = pgTable("wordart_presets", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  style: jsonb("style").$type<Record<string, unknown>>().notNull(),
  scope: text("scope").notNull().default("user"),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
});

// ============================================
// Themes
// ============================================

/**
 * Color values for shadcn/ui CSS custom properties.
 * Uses OKLCH format (e.g., "oklch(0.205 0 0)") matching
 * the shadcn/ui v4 color system.
 *
 * Each theme defines both light (:root) and dark (.dark) mode values.
 */
export interface ThemeColors {
  // Light mode
  background: string;
  foreground: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  input: string;
  ring: string;
  // Dark mode
  darkBackground: string;
  darkForeground: string;
  darkCard: string;
  darkCardForeground: string;
  darkPopover: string;
  darkPopoverForeground: string;
  darkPrimary: string;
  darkPrimaryForeground: string;
  darkSecondary: string;
  darkSecondaryForeground: string;
  darkMuted: string;
  darkMutedForeground: string;
  darkAccent: string;
  darkAccentForeground: string;
  darkDestructive: string;
  darkDestructiveForeground: string;
  darkBorder: string;
  darkInput: string;
  darkRing: string;
}

/**
 * Themes table — stores color themes (presets + user-created).
 * Each theme contains OKLCH CSS variable values for shadcn/ui components.
 */
export const themes = pgTable("themes", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Theme display name (e.g., "Violet", "Ocean") */
  name: text("name").notNull(),
  /** OKLCH color values for all CSS custom properties */
  colors: jsonb("colors").$type<ThemeColors>().notNull(),
  /** Whether this is a built-in preset (cannot be deleted/edited) */
  isPreset: boolean("is_preset").default(false),
  /** User who created this theme (null for presets) */
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date" }).defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});

/**
 * User theme preferences — tracks which theme each user has selected.
 * One active theme per user.
 */
export const userThemePreferences = pgTable("user_theme_preferences", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** User this preference belongs to (unique per user) */
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Currently active theme */
  themeId: uuid("theme_id")
    .notNull()
    .references(() => themes.id, { onDelete: "cascade" }),
  /** Optional per-app theme overrides (stretch goal) */
  appOverrides: jsonb("app_overrides").$type<Record<string, string>>().default({}),
  updatedAt: timestamp("updated_at", { mode: "date" }).defaultNow(),
});
