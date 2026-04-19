/**
 * Zod schemas for youeye-app.yaml manifest validation (v2).
 * Validates app manifests fetched from the YE-AppMarket catalog or from repo URLs.
 *
 * v2 changes:
 *   - `integration: native|basic` replaces `type: native|marketplace`
 *   - Every container has explicit `type: lxd|oci`
 *   - `env_mapping` replaces hardcoded buildPlatformEnv()
 *   - `database.mode: shared|own|none` replaces requiresSharedPostgres
 *   - `sso.setup.method: env|api|cli` replaces sso.configure.type
 *   - Volume types: config|data|media|cache
 *   - Container naming: app-{appId} (single) or app-{appId}-{name} (multi)
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
  website: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  defaultSubdomain: z.string().min(1),
  estimatedMemory: z.string().optional(),
  estimatedCPU: z.string().optional(),
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

// ─── Volume (v2: typed volumes) ───────────────────────────

export const VolumeSchema = z.object({
  name: z.string().optional(),
  host: z.string().min(1),
  container: z.string().min(1),
  type: z.enum(['config', 'data', 'media', 'cache']).default('data'),
  containers: z.array(z.string()).optional(),
  read_only: z.boolean().default(false),
});

// ─── Post-Deploy Step ─────────────────────────────────────

export const PostDeployStepSchema = z.object({
  exec: z.string().min(1),
  timeout: z.number().int().positive().default(30_000),
});

// ─── Connector ────────────────────────────────────────────

export const ConnectorRequirementSchema = z.object({
  capability: z.string().min(1),
});

export const ConnectorProvisionSchema = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  description: z.string().optional(),
});

export const ConnectorsSchema = z.object({
  requires: z.array(ConnectorRequirementSchema).default([]),
  provides: z.array(ConnectorProvisionSchema).default([]),
});

// ─── Container Source (LXD-only: Gitea repo deploy) ───────

export const ContainerSourceSchema = z.object({
  repo: z.string().min(1),
  nodeVersion: z.string().optional(),
  appDir: z.string().default('/opt/app'),
  tagPrefix: z.string().optional(),
});

// ─── Container (v2: explicit type) ────────────────────────

export const ContainerSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/, 'Container name must be lowercase alphanumeric with dashes'),
  type: z.enum(['lxd', 'oci']),
  primary: z.boolean().optional().default(false),
  image: z.string().min(1),
  port: z.number().int().positive().optional(),
  command: z.string().optional(),
  environment: z.record(z.string(), z.string()).default({}),
  volumes: z.array(VolumeSchema).default([]),
  healthCheck: HealthCheckSchema.optional(),
  source: ContainerSourceSchema.optional(),
  postDeploy: z.array(PostDeployStepSchema).optional().default([]),
});

// ─── Secrets ───────────────────────────────────────────────

export const SecretSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Secret name must be lowercase alphanumeric with underscores'),
  file: z.string().min(1),
  generator: z.enum(['password', 'secretKey', 'hexToken']),
  length: z.number().int().positive().default(32),
});

// ─── Database (v2: replaces requiresSharedPostgres) ───────

export const DatabaseSchema = z.object({
  mode: z.enum(['shared', 'own', 'none']),
  name: z.string().optional(),
  user: z.string().optional(),
  container: z.string().optional(),
}).refine(
  (data) => {
    if (data.mode === 'shared') return !!data.name && !!data.user;
    if (data.mode === 'own') return !!data.container;
    return true;
  },
  { message: 'shared requires name+user; own requires container' }
);

// ─── Config Files ──────────────────────────────────────────

export const ConfigFileSchema = z.object({
  path: z.string().min(1),
  permission: z.string().default('0o644'),
  directoryPermission: z.string().default('0o700'),
  template: z.string().min(1),
});

// ─── SSO (v2: setup methods) ──────────────────────────────

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

export const SSOCliStepSchema = z.object({
  exec: z.string().min(1),
  timeout: z.number().int().positive().default(30_000),
});

export const SSOSetupSchema = z.object({
  method: z.enum(['env', 'api', 'cli', 'none']),
  api: z.object({ steps: z.array(SSOStepSchema).default([]) }).optional(),
  cli: z.object({ steps: z.array(SSOCliStepSchema).default([]) }).optional(),
});

export const RedirectUriSchema = z.object({
  url: z.string().min(1),
});

export const SSOSchema = z.object({
  type: z.enum(['oauth2', 'ldap']).default('oauth2'),
  callback_path: z.string().min(1),
  additional_callbacks: z.array(z.string()).default([]),
  // Legacy fields (kept for backward compat during migration)
  authentikSlug: z.string().optional(),
  redirectUris: z.array(RedirectUriSchema).optional(),
  configure: z.object({
    type: z.enum(['http-api', 'exec', 'none']),
    steps: z.array(SSOStepSchema).default([]),
  }).optional(),
  // v2 setup
  setup: SSOSetupSchema.optional(),
});

// ─── Capabilities (v2: extended) ─────────────────────────

export const CapabilitiesSchema = z.object({
  notifications: z.union([z.boolean(), z.literal('push')]).optional(),
  smtp: z.boolean().optional(),
  ai_api: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  widgets: z.boolean().optional(),
  info_cards: z.boolean().optional(),
  settings_panel: z.boolean().optional(),
  connectors: z.object({
    provides: z.array(z.string()).default([]),
    consumes: z.array(z.string()).default([]),
  }).optional(),
}).optional();

// ─── Install Parameters ───────────────────────────────────

export const InstallParamSchema = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  required: z.boolean().default(false),
  description: z.string().optional(),
  type: z.enum(['string', 'number', 'boolean', 'select', 'password']).optional().default('string'),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  choices: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
  validation: z.object({
    pattern: z.string().optional(),
    message: z.string().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  }).optional(),
});

// ─── Entrances (multi-entrance routing) ──────────────────

export const EntranceSchema = z.object({
  name: z.string().min(1),
  path: z.string().optional().default('/'),
  port: z.number().int().positive(),
  container: z.string().optional(),
  protocol: z.enum(['http', 'tcp']).optional().default('http'),
  authLevel: z.enum(['private', 'public', 'internal', 'none']).optional().default('private'),
  stripPath: z.boolean().optional().default(false),
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

// ─── Update / Migration (v2: pre/post hooks, version constraint) ──

export const MigrationStepSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('exec'),
    container: z.string().min(1),
    command: z.string().min(1),
    timeout: z.number().int().positive().default(60_000),
  }),
  z.object({
    type: z.literal('sql'),
    database: z.string().min(1),
    command: z.string().min(1),
  }),
]);

export const MigrationSchema = z.object({
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  steps: z.array(MigrationStepSchema).min(1),
});

export const UpdateHookStepSchema = z.object({
  exec_in: z.string().min(1),
  run: z.string().min(1),
  timeout: z.number().int().positive().default(30_000),
});

export const UpdateSchema = z.object({
  strategy: z.enum(['replace', 'migrate']).default('replace'),
  preserveData: z.boolean().default(true),
  preserveSecrets: z.boolean().default(true),
  version_constraint: z.enum(['any', 'major-sequential']).default('any'),
  pre_update: z.array(UpdateHookStepSchema).optional().default([]),
  post_update: z.array(UpdateHookStepSchema).optional().default([]),
  migrations: z.array(MigrationSchema).optional().default([]),
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

// ─── Root Manifest (v2) ───────────────────────────────────

export const AppManifestSchema = z
  .object({
    apiVersion: z.enum(['v1', 'v2']),
    kind: z.literal('app'),
    integration: z.enum(['native', 'basic']).default('basic'),
    version: z.string().min(1).optional(),

    // Legacy v1 field — mapped to integration at parse time
    type: z.enum(['marketplace', 'native']).optional(),

    metadata: MetadataSchema,

    // v2: database section replaces features.requiresSharedPostgres
    database: DatabaseSchema.optional(),

    // v2: env_mapping replaces buildPlatformEnv() hardcoded injection
    env_mapping: z.record(z.string(), z.string()).optional().default({}),

    containers: z.array(ContainerSchema).default([]),

    // Legacy v1 fields
    features: z.object({
      supportsSSO: z.boolean().default(false),
      requiresSharedPostgres: z.boolean().default(false),
    }).optional(),
    native: z.object({
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
      postDeploy: z.array(PostDeployStepSchema).optional().default([]),
    }).optional(),
    sharedPostgres: z.object({
      database: z.string().min(1),
      user: z.string().min(1),
      password: z.string().min(1),
    }).optional(),

    secrets: z.array(SecretSchema).optional().default([]),
    configFiles: z.array(ConfigFileSchema).optional().default([]),
    capabilities: CapabilitiesSchema,
    connectors: ConnectorsSchema.optional(),
    installParams: z.array(InstallParamSchema).optional().default([]),
    forwardAuth: z.enum(['default', 'enabled', 'disabled']).optional(),
    entrances: z.array(EntranceSchema).optional(),
    sso: SSOSchema.optional(),
    backup: BackupSchema.optional(),
    uninstall: UninstallSchema.optional(),
    update: UpdateSchema.optional(),
    detail: DetailSchema.optional(),

    // Legacy v1 language (use env_mapping with ${platform.locale} instead)
    language: z.object({
      env_var: z.string().min(1),
      format: z.enum(['iso639', 'full']).default('iso639'),
    }).optional(),
  })
  .refine(
    (data) => {
      // v1 native manifests pass through (legacy compat during migration)
      if (data.apiVersion === 'v1') return true;
      // v2 apps must have at least one container
      if (data.containers.length === 0) return false;
      // Single-container apps: OK
      if (data.containers.length === 1) return true;
      // Multi-container: exactly one primary
      const primaries = data.containers.filter((c) => c.primary);
      return primaries.length === 1;
    },
    { message: 'v2 apps must have containers; multi-container apps must have exactly one primary' }
  )
  .refine(
    (data) => {
      if (data.apiVersion === 'v1') return true;
      // LXD containers with source must have repo
      for (const c of data.containers) {
        if (c.type === 'lxd' && c.source && !c.source.repo) return false;
      }
      return true;
    },
    { message: 'LXD containers with source must specify a repo' }
  );

// ─── Catalog Schema (v2: flat list) ───────────────────────

export const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  // For apps with manifest in AppMarket (third-party)
  file: z.string().optional(),
  // For apps with manifest in their own repo
  repo: z.string().optional(),
  manifest: z.string().default('youeye-app.yaml'),
  integration: z.enum(['native', 'basic']).default('basic'),
  latestVersion: z.string().optional(),
  minPlatformVersion: z.string().optional(),
});

export const SystemCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
});

export const CatalogSchema = z.object({
  apiVersion: z.enum(['v1', 'v2']),
  kind: z.literal('catalog'),
  // v2: flat list
  apps: z.array(CatalogEntrySchema).default([]),
  system: z.array(SystemCatalogEntrySchema).default([]),
  // Legacy v1 fields
  native: z.array(z.object({
    id: z.string().min(1),
    file: z.string().min(1),
    type: z.literal('native').default('native'),
  })).default([]),
  external: z.array(CatalogEntrySchema).default([]),
});

// ─── App Ref (legacy v1: native app pointer) ──────────────

export const AppRefSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('app-ref'),
  type: z.literal('native'),
  repo: z.string().min(1),
  manifest: z.string().min(1),
});
