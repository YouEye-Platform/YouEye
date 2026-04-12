/**
 * Market engine types.
 * Inferred from Zod schemas + runtime types for install flow.
 */

import type { z } from 'zod/v4';
import type {
  AppManifestSchema,
  MetadataSchema,
  FeaturesSchema,
  ContainerSchema,
  SecretSchema,
  SharedPostgresSchema,
  ConfigFileSchema,
  CapabilitiesSchema,
  SSOSchema,
  SSOStepSchema,
  BackupSchema,
  UninstallSchema,
  UpdateSchema,
  MigrationSchema,
  MigrationStepSchema,
  HealthCheckSchema,
  CatalogSchema,
  CatalogEntrySchema,
  NativeCatalogEntrySchema,
  SystemCatalogEntrySchema,
  NativeConfigSchema,
  DetailSchema,
  DetailScreenshotSchema,
  AppRefSchema,
  InstallParamSchema,
} from './schema';

// ─── Manifest Types (from Zod) ─────────────────────────────

export type AppManifest = z.infer<typeof AppManifestSchema>;
export type AppMetadata = z.infer<typeof MetadataSchema>;
export type AppFeatures = z.infer<typeof FeaturesSchema>;
export type ContainerSpec = z.infer<typeof ContainerSchema>;
export type SecretSpec = z.infer<typeof SecretSchema>;
export type SharedPostgresSpec = z.infer<typeof SharedPostgresSchema>;
export type ConfigFileSpec = z.infer<typeof ConfigFileSchema>;
export type SSOConfig = z.infer<typeof SSOSchema>;
export type SSOStep = z.infer<typeof SSOStepSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type BackupSpec = z.infer<typeof BackupSchema>;
export type UninstallSpec = z.infer<typeof UninstallSchema>;
export type UpdateSpec = z.infer<typeof UpdateSchema>;
export type MigrationSpec = z.infer<typeof MigrationSchema>;
export type MigrationStep = z.infer<typeof MigrationStepSchema>;
export type HealthCheckSpec = z.infer<typeof HealthCheckSchema>;
export type NativeConfig = z.infer<typeof NativeConfigSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type NativeCatalogEntry = z.infer<typeof NativeCatalogEntrySchema>;
export type SystemCatalogEntry = z.infer<typeof SystemCatalogEntrySchema>;
export type AppDetail = z.infer<typeof DetailSchema>;
export type DetailScreenshot = z.infer<typeof DetailScreenshotSchema>;
export type AppRef = z.infer<typeof AppRefSchema>;
export type InstallParam = z.infer<typeof InstallParamSchema>;

// ─── Install Config ────────────────────────────────────────

export interface InstallConfig {
  appId: string;
  subdomain: string;
  domain: string;
  /** Optional app-specific install parameters (e.g. { tmdbApiKey: '...' } for Cinema) */
  installParams?: Record<string, string>;
  /** Custom display name chosen by user at install time (defaults to manifest name) */
  customName?: string;
  /** Custom icon chosen by user at install time (emoji:X, lucide name, or uploaded URL) */
  customIcon?: string;
}

// ─── Install Metadata (persisted) ──────────────────────────

export interface InstallMetadata {
  appId: string;
  type?: 'marketplace' | 'native';
  subdomain: string;
  domain: string;
  enableSSO: boolean;
  installedAt: string;
  installedVersion?: string;
  containers: string[];
  ssoSlug?: string;
  ssoClientId?: string;
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
}

export interface ContainerStatusInfo {
  name: string;
  status: 'running' | 'stopped' | 'not-found';
  ip?: string;
}

// ─── Variable Context ──────────────────────────────────────

export interface VariableContext {
  app: { id: string };
  install: { url: string; subdomain: string; domain: string };
  secrets: Record<string, string>;
  container: { ip: string; port: number };
  sso: { clientId: string; clientSecret: string };
  authentik: { externalUrl: string; internalUrl: string; name: string };
  smtp?: { host: string; port: string; username: string; password: string; from: string; tls: string; configured: string };
  platform?: { version: string; domain: string; siteName: string; timezone: string; locale: string };
}

// ─── Catalog App (UI display) ──────────────────────────────

export interface MarketApp {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconUrl?: string;
  category: string;
  type: 'marketplace' | 'native';
  version?: string;
  defaultSubdomain: string;
  supportsSSO: boolean;
  estimatedMemory: string;
  estimatedCPU: string;
  website: string;
  tags: string[];
  // Detail page fields
  detail?: {
    longDescription: string;
    screenshots: { url: string; caption?: string }[];
  };
  // Install params (for apps like Cinema that need user input)
  installParams?: { name: string; label: string; required: boolean; description?: string }[];
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
