/**
 * Market engine types (v2).
 * Inferred from Zod schemas + runtime types for install flow.
 */

import type { z } from 'zod/v4';
import type {
  AppManifestSchema,
  MetadataSchema,
  ContainerSchema,
  ContainerSourceSchema,
  SecretSchema,
  DatabaseSchema,
  ConfigFileSchema,
  CapabilitiesSchema,
  SSOSchema,
  SSOStepSchema,
  SSOSetupSchema,
  SSOCliStepSchema,
  BackupSchema,
  UninstallSchema,
  UpdateSchema,
  UpdateHookStepSchema,
  MigrationSchema,
  MigrationStepSchema,
  HealthCheckSchema,
  CatalogSchema,
  CatalogEntrySchema,
  SystemCatalogEntrySchema,
  DetailSchema,
  DetailScreenshotSchema,
  AppRefSchema,
  InstallParamSchema,
  ConnectorsSchema,
  PostDeployStepSchema,
  VolumeSchema,
} from './schema';

// ─── Manifest Types (from Zod) ─────────────────────────────

export type AppManifest = z.infer<typeof AppManifestSchema>;
export type AppMetadata = z.infer<typeof MetadataSchema>;
export type ContainerSpec = z.infer<typeof ContainerSchema>;
export type ContainerSource = z.infer<typeof ContainerSourceSchema>;
export type SecretSpec = z.infer<typeof SecretSchema>;
export type DatabaseSpec = z.infer<typeof DatabaseSchema>;
export type ConfigFileSpec = z.infer<typeof ConfigFileSchema>;
export type SSOConfig = z.infer<typeof SSOSchema>;
export type SSOStep = z.infer<typeof SSOStepSchema>;
export type SSOSetup = z.infer<typeof SSOSetupSchema>;
export type SSOCliStep = z.infer<typeof SSOCliStepSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type BackupSpec = z.infer<typeof BackupSchema>;
export type UninstallSpec = z.infer<typeof UninstallSchema>;
export type UpdateSpec = z.infer<typeof UpdateSchema>;
export type UpdateHookStep = z.infer<typeof UpdateHookStepSchema>;
export type MigrationSpec = z.infer<typeof MigrationSchema>;
export type MigrationStep = z.infer<typeof MigrationStepSchema>;
export type HealthCheckSpec = z.infer<typeof HealthCheckSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type SystemCatalogEntry = z.infer<typeof SystemCatalogEntrySchema>;
export type AppDetail = z.infer<typeof DetailSchema>;
export type DetailScreenshot = z.infer<typeof DetailScreenshotSchema>;
export type AppRef = z.infer<typeof AppRefSchema>;
export type InstallParam = z.infer<typeof InstallParamSchema>;
export type ConnectorsSpec = z.infer<typeof ConnectorsSchema>;
export type PostDeployStep = z.infer<typeof PostDeployStepSchema>;
export type VolumeSpec = z.infer<typeof VolumeSchema>;

// Legacy type aliases (kept for files that import them during migration)
export type AppFeatures = { supportsSSO: boolean; requiresSharedPostgres: boolean };
export type NativeConfig = NonNullable<AppManifest['native']>;
export type NativeCatalogEntry = { id: string; file: string; type: 'native' };
export type SharedPostgresSpec = { database: string; user: string; password: string };

// ─── Install Config ────────────────────────────────────────

export interface InstallConfig {
  appId: string;
  subdomain: string;
  domain: string;
  /** Optional app-specific install parameters */
  installParams?: Record<string, string>;
  /** Custom display name chosen by user at install time */
  customName?: string;
  /** Custom icon chosen by user at install time */
  customIcon?: string;
  /** Repo URL for custom (non-catalog) installs */
  repoUrl?: string;
  /** Branch/tag for repo-based installs */
  repoBranch?: string;
}

// ─── Install Metadata (persisted to install.json) ──────────

export interface ContainerMeta {
  name: string;
  containerName: string;
  type: 'lxd' | 'oci';
}

export interface InstallMetadata {
  appId: string;
  integration: 'native' | 'basic';
  subdomain: string;
  domain: string;
  enableSSO: boolean;
  forwardAuthEnabled?: boolean;
  installedAt: string;
  installedVersion?: string;
  containers: ContainerMeta[];
  ssoSlug?: string;
  ssoClientId?: string;
  forwardAuthSlug?: string;
  manifestSource?: string;

  // Legacy v1 field — kept for reading old install.json files
  type?: 'marketplace' | 'native';
}

// ─── Install Events (SSE) ──────────────────────────────────

export interface InstallEvent {
  step: number;
  totalSteps: number;
  status: 'running' | 'success' | 'error' | 'skipped';
  message: string;
  detail?: string;
}

export type InstallEventCallback = (event: InstallEvent) => void;

// ─── App Status ────────────────────────────────────────────

export type AppStatus = 'not-installed' | 'installing' | 'running' | 'stopped' | 'error' | 'partial';

export interface AppStatusInfo {
  appId: string;
  status: AppStatus;
  containers: ContainerStatusInfo[];
  subdomain?: string;
  domain?: string;
  url?: string;
  installedAt?: string;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt?: string | null;
  forwardAuthEnabled?: boolean;
}

export interface ContainerStatusInfo {
  name: string;
  status: 'running' | 'stopped' | 'not-found';
  ip?: string;
}

// ─── Variable Context (v2: canonical) ──────────────────────

export interface VariableContext {
  platform: {
    domain: string;
    version: string;
    locale: string;
    locale_full: string;
    timezone: string;
    site_name: string;
    proxy_ip: string;
  };
  app: {
    id: string;
    name: string;
    subdomain: string;
    fqdn: string;
    url: string;
    internal_url: string;
  };
  integration: {
    gateway_url: string;
    app_token: string;
  };
  containers: Record<string, {
    internal_host: string;
    internal_url: string;
  }>;
  database: {
    url: string;
    dsn: string;
    host: string;
    port: string;
    name: string;
    user: string;
    password: string;
  };
  sso: {
    issuer: string;
    discovery_url: string;
    client_id: string;
    client_secret: string;
    callback_url: string;
    logout_url: string;
  };
  smtp: {
    host: string;
    port: string;
    user: string;
    password: string;
    from: string;
    security: string;
  };
  secrets: Record<string, string>;
  installParams: Record<string, string>;

  // Legacy aliases — kept for SSO step compat (v1 manifests reference these)
  install: { url: string; subdomain: string; domain: string };
  authentik: { externalUrl: string; internalUrl: string; name: string };
  container: { ip: string; port: number };
}

// ─── Catalog App (UI display) ──────────────────────────────

export interface MarketApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconUrl?: string;
  category: string;
  integration: 'native' | 'basic';
  version?: string;
  defaultSubdomain: string;
  supportsSSO: boolean;
  website?: string;
  tags: string[];
  detail?: {
    longDescription: string;
    screenshots: { url: string; caption?: string }[];
  };
  installParams?: {
    name: string;
    label: string;
    required: boolean;
    description?: string;
    type?: 'string' | 'number' | 'boolean' | 'select' | 'password';
    default?: string | number | boolean;
    choices?: { value: string; label: string }[];
    validation?: {
      pattern?: string;
      message?: string;
      min?: number;
      max?: number;
    };
  }[];
  entrances?: {
    name: string;
    path: string;
    port: number;
    container?: string;
    protocol?: 'http' | 'tcp';
    authLevel?: 'private' | 'public' | 'internal' | 'none';
    stripPath?: boolean;
  }[];
  forwardAuth?: 'default' | 'enabled' | 'disabled';
  capabilities?: {
    widgets?: boolean;
    notifications?: boolean | 'push';
    smtp?: boolean;
    connectors?: { provides?: string[]; consumes?: string[] };
  };

  // Legacy field — UI may still reference this
  type?: 'marketplace' | 'native';
}

// ─── Restore Options ─────────────────────────────────────

export interface RestoreOptions {
  skipSecrets: boolean;
  skipDatabase: boolean;
  skipConfigFiles: boolean;
}

// ─── Uninstall Options ────────────────────────────────────

export interface UninstallOptions {
  keepData: boolean;
}

// ─── Uninstall Verification ───────────────────────────────

export interface UninstallVerification {
  containerRemoved: boolean;
  caddyRouteRemoved: boolean;
  authentikAppRemoved: boolean;
  dnsRemoved: boolean;
  databaseDropped: boolean | null;
  dataRemoved: boolean | null;
  warnings: string[];
}

// ─── Orphan Resource ──────────────────────────────────────

export type OrphanType = 'caddy-route' | 'authentik-app' | 'authentik-provider' | 'postgres-db' | 'dns-entry' | 'volume-dir' | 'container';

export interface OrphanResource {
  type: OrphanType;
  identifier: string;
  detail?: string;
  action: 'can-remove';
}
