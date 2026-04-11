/**
 * Zod schemas for youeye-file.yaml manifest validation.
 * Validates app manifests fetched from the YE-AppMarket catalog.
 *
 * Based on: youeye-file.md specification (v1)
 * Container naming: app-{appId} (single) or app-{appId}-{name} (multi)
 */

import { z } from 'zod/v4';

// ─── Metadata ──────────────────────────────────────────────

export const MetadataSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'ID must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().min(1),
  iconUrl: z.string().optional(),
  category: z.enum(['search', 'social', 'productivity', 'media', 'utilities', 'infrastructure']),
  website: z.string().url(),
  tags: z.array(z.string()).default([]),
  defaultSubdomain: z.string().min(1),
  estimatedMemory: z.string().min(1),
  estimatedCPU: z.string().min(1),
});

// ─── Features ──────────────────────────────────────────────

export const FeaturesSchema = z.object({
  supportsSSO: z.boolean().default(false),
  requiresSharedPostgres: z.boolean().default(false),
});

// ─── Health Check ──────────────────────────────────────────

export const HealthCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    path: z.string().default('/'),
    timeout: z.number().int().positive().default(120_000),
  }),
  z.object({
    type: z.literal('postgres'),
    user: z.string().min(1),
    timeout: z.number().int().positive().default(60_000),
  }),
]);

// ─── Volume ────────────────────────────────────────────────

export const VolumeSchema = z.object({
  host: z.string().min(1),
  container: z.string().min(1),
});

// ─── Resource Limits ───────────────────────────────────────

export const LimitsSchema = z.object({
  memory: z.string().min(1),
  cpu: z.string().min(1),
});

// ─── Container ─────────────────────────────────────────────

export const ContainerSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Container name must be lowercase alphanumeric with dashes'),
  primary: z.boolean().optional().default(false),
  image: z.string().min(1),
  port: z.number().int().positive().optional(),
  command: z.string().optional(),
  limits: LimitsSchema,
  environment: z.record(z.string(), z.string()).default({}),
  volumes: z.array(VolumeSchema).default([]),
  healthCheck: HealthCheckSchema.optional(),
});

// ─── Secrets ───────────────────────────────────────────────

export const SecretSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Secret name must be lowercase alphanumeric with underscores'),
  file: z.string().min(1),
  generator: z.enum(['password', 'secretKey', 'hexToken']),
  length: z.number().int().positive().default(32),
});

// ─── Shared Postgres ───────────────────────────────────────

export const SharedPostgresSchema = z.object({
  database: z.string().min(1),
  user: z.string().min(1),
  password: z.string().min(1), // variable reference like ${secrets.db_password}
});

// ─── Config Files ──────────────────────────────────────────

export const ConfigFileSchema = z.object({
  path: z.string().min(1),
  permission: z.string().default('0o644'),
  directoryPermission: z.string().default('0o700'),
  template: z.string().min(1),
});

// ─── SSO Configuration Steps ───────────────────────────────

export const SSOStepSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  url: z.string().min(1),
  body: z.unknown().optional(),
  auth: z.string().optional(),
  extractToken: z
    .object({
      from: z.string().min(1),
      as: z.string().min(1),
    })
    .optional(),
  saveAs: z.string().optional(),
  ignoreError: z.boolean().optional().default(false),
  condition: z.string().optional(),
  forEach: z.string().optional(),
  action: z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
      url: z.string().min(1),
      auth: z.string().optional(),
    })
    .optional(),
});

export const SSOConfigureSchema = z.object({
  type: z.enum(['http-api', 'exec', 'none']),
  steps: z.array(SSOStepSchema).default([]),
});

export const RedirectUriSchema = z.object({
  url: z.string().min(1),
});

export const SSOSchema = z.object({
  authentikSlug: z.string().min(1),
  redirectUris: z.array(RedirectUriSchema).min(1),
  configure: SSOConfigureSchema,
});

// ─── Capabilities ────────────────────────────────────────

export const CapabilitiesSchema = z.object({
  notifications: z.literal('push').optional(),
  smtp: z.boolean().optional(),
  ai_api: z.boolean().optional(),
}).optional();

// ─── Language ─────────────────────────────────────────────

export const LanguageConfigSchema = z.object({
  env_var: z.string().min(1),
  format: z.enum(['iso639', 'full']).default('iso639'),
});

// ─── Backup ───────────────────────────────────────────────

export const OwnPostgresSchema = z.object({
  container: z.string().min(1),
  database: z.string().min(1),
});

export const BackupSchema = z.object({
  strategy: z.enum(['stop-dump-export', 'live-export', 'snapshot']).optional().default('stop-dump-export'),
  stopOrder: z.array(z.string()).optional().default([]),
  startOrder: z.array(z.string()).optional().default([]),
  ownPostgres: OwnPostgresSchema.optional(),
  volumes: z.array(z.string()).optional().default([]),
  exclude: z.array(z.string()).optional().default([]),
});

// ─── Uninstall ─────────────────────────────────────────────

export const UninstallSchema = z.object({
  dropSharedDatabase: z.boolean().optional().default(false),
  preDeleteCommands: z.array(z.string()).optional().default([]),
});

// ─── Native App Config ────────────────────────────────────

export const InstallParamSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(false),
  description: z.string().optional(),
});

export const NativeConfigSchema = z.object({
  repo: z.string().min(1),
  containerName: z.string().min(1),
  port: z.number().int().positive(),
  image: z.string().min(1),
  imageServer: z.string().url().optional(),
  nodeVersion: z.string().optional(),
  appDir: z.string().optional(),
  healthCheck: HealthCheckSchema.optional(),
  environment: z.record(z.string(), z.string()).default({}),
  installParams: z.array(InstallParamSchema).optional().default([]),
});

// ─── Detail (app detail page) ─────────────────────────────

export const DetailScreenshotSchema = z.object({
  path: z.string().min(1),
  caption: z.string().optional(),
});

export const DetailSchema = z.object({
  longDescription: z.string().min(1),
  screenshots: z.array(DetailScreenshotSchema).default([]),
});

// ─── Root Manifest ─────────────────────────────────────────

export const AppManifestSchema = z
  .object({
    apiVersion: z.literal('v1'),
    kind: z.literal('app'),
    type: z.enum(['marketplace', 'native']).optional().default('marketplace'),
    version: z.string().min(1).optional(),
    metadata: MetadataSchema,
    features: FeaturesSchema,
    containers: z.array(ContainerSchema).optional().default([]),
    native: NativeConfigSchema.optional(),
    secrets: z.array(SecretSchema).optional().default([]),
    sharedPostgres: SharedPostgresSchema.optional(),
    configFiles: z.array(ConfigFileSchema).optional().default([]),
    language: LanguageConfigSchema.optional(),
    capabilities: CapabilitiesSchema,
    sso: SSOSchema.optional(),
    backup: BackupSchema.optional(),
    uninstall: UninstallSchema.optional(),
    detail: DetailSchema.optional(),
  })
  .refine(
    (data) => {
      // Native apps don't use container specs
      if (data.type === 'native') return true;
      // Marketplace apps must have at least one container
      if (data.containers.length === 0) return false;
      // Exactly one container must be marked as primary, or if only one container, it's implicitly primary
      if (data.containers.length === 1) return true;
      const primaries = data.containers.filter((c) => c.primary);
      return primaries.length === 1;
    },
    { message: 'Marketplace apps must have containers; multi-container apps must have exactly one primary' }
  )
  .refine(
    (data) => {
      // Native apps must have native config
      if (data.type === 'native' && !data.native) return false;
      return true;
    },
    { message: 'Native apps must have a native config block' }
  )
  .refine(
    (data) => {
      // If requiresSharedPostgres is true, sharedPostgres config must be provided
      if (data.features.requiresSharedPostgres && !data.sharedPostgres) {
        return false;
      }
      return true;
    },
    { message: 'sharedPostgres config is required when features.requiresSharedPostgres is true' }
  )
  .refine(
    (data) => {
      // If supportsSSO is true, sso config must be provided
      if (data.features.supportsSSO && !data.sso) {
        return false;
      }
      return true;
    },
    { message: 'sso config is required when features.supportsSSO is true' }
  );

// ─── Catalog Schema ────────────────────────────────────────

export const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
  type: z.enum(['native', 'marketplace']).optional().default('marketplace'),
});

export const NativeCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  type: z.literal('native').default('native'),
});

export const SystemCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
});

export const CatalogSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('catalog'),
  native: z.array(NativeCatalogEntrySchema).default([]),
  external: z.array(CatalogEntrySchema).default([]),
  system: z.array(SystemCatalogEntrySchema).default([]),
});

// ─── App Ref (native app pointer) ──────────────────────────

export const AppRefSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('app-ref'),
  type: z.literal('native'),
  repo: z.string().min(1),
  manifest: z.string().min(1),
});
