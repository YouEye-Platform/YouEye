/**
 * Zod schemas for youeye-app.yaml manifest validation.
 * Validates app manifests fetched from the Market catalog or from repo URLs.
 *
 * Single format — apiVersion: v1. No backwards compatibility needed (pre-beta).
 *
 * Key structural decisions:
 *   - `integration: native|basic` — native = LXD containers from Gitea, basic = OCI images
 *   - Every container has explicit `type: lxd|oci`
 *   - `env_mapping` with ${variable} substitution for all environment injection
 *   - `database.mode: shared|own|none` for database configuration
 *   - `sso.setup.method: env|api|cli|none` for SSO setup
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
  category: z.string().min(1),
  website: z.string().url().optional(),
  tags: z.array(z.string()).default([]),
  defaultSubdomain: z.string().min(1),
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

// ─── Volume ───────────────────────────────────────────────

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

// ─── Container Source (LXD-only: Gitea repo deploy) ───────

export const ContainerSourceSchema = z.object({
  repo: z.string().min(1),
  nodeVersion: z.string().optional(),
  appDir: z.string().default('/opt/app'),
  tagPrefix: z.string().optional(),
});

// ─── Container ────────────────────────────────────────────

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
  network: z.enum(['isolated', 'internet']).optional().default('isolated'),
});

// ─── Secrets ───────────────────────────────────────────────

export const SecretSchema = z.object({
  name: z.string().regex(/^[a-z0-9_]+$/, 'Secret name must be lowercase alphanumeric with underscores'),
  file: z.string().min(1),
  generator: z.enum(['password', 'secretKey', 'hexToken']),
  length: z.number().int().positive().default(32),
});

// ─── Credentials (admin-visible default accounts) ─────────

export const CredentialSchema = z.object({
  label: z.string().min(1),
  username: z.string().min(1),
  passwordSecret: z.string().min(1),
});

// ─── Database ─────────────────────────────────────────────

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

// ─── SSO Admin Mapping ────────────────────────────────────

export const AdminMappingSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('groups'),
    groupName: z.string().min(1),
  }),
  z.object({
    type: z.literal('roleClaim'),
    claimName: z.string().min(1),
    adminValue: z.string().min(1),
    defaultValue: z.string().min(1),
  }),
]);

// ─── SSO ──────────────────────────────────────────────────

export const SSOStepSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional(),
  url: z.string().optional(),
  body: z.unknown().optional(),
  auth: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  delay: z.number().int().positive().optional(),
  extractToken: z
    .object({
      from: z.string().min(1),
      as: z.string().min(1),
    })
    .optional(),
  extractCookie: z
    .object({
      name: z.string().min(1),
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
      headers: z.record(z.string(), z.string()).optional(),
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

export const SSOSchema = z.object({
  type: z.enum(['oauth2', 'ldap']).default('oauth2'),
  callback_path: z.string().min(1),
  entry_url: z.string().optional(),
  additional_callbacks: z.array(z.string()).default([]),
  adminMapping: AdminMappingSchema.optional(),
  setup: SSOSetupSchema.optional(),
});

// ─── Capabilities ─────────────────────────────────────────

const LinkHandlerSchema = z.object({
  type: z.string().min(1),
  description: z.string(),
  endpoint: z.string().optional().default('/'),
  triggers: z.array(z.string().min(1)).min(1),
});

export const CapabilitiesSchema = z.object({
  notifications: z.union([z.boolean(), z.literal('push')]).optional(),
  smtp: z.boolean().optional(),
  ai_api: z.boolean().optional(),
  events: z.array(z.string()).optional(),
  widgets: z.boolean().optional(),
  info_cards: z.boolean().optional(),
  settings_panel: z.boolean().optional(),
  link_handlers: z.array(LinkHandlerSchema).optional(),
}).optional();

// ─── Provides (capability declarations) ──────────────────

export const ProvidesSchema = z.object({
  type: z.string().min(1),
  description: z.string().optional(),
  port: z.number().int().positive().optional(),
});

// ─── Wants (app-to-app connection declarations) ──────────

/** System container IDs — never valid bridge/want targets */
const SYSTEM_APP_IDS = [
  'postgres', 'authentik', 'caddy', 'pihole', 'control', 'ui',
  'authentik-worker',
];

export const WantSchema = z.object({
  appId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  defaultPort: z.number().int().positive().optional(),
}).refine(
  (data) => !!(data.appId || data.type),
  { message: 'wants must specify appId or type' }
).refine(
  (data) => !(data.appId && SYSTEM_APP_IDS.includes(data.appId)),
  { message: 'wants cannot target system containers' }
);

// ─── Internet (per-host egress declarations) ─────────────

export const InternetSchema = z.object({
  hosts: z.array(z.string()).default([]),
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

// ─── Update / Migration ───────────────────────────────────

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

// ─── Root Manifest ────────────────────────────────────────

export const AppManifestSchema = z
  .object({
    apiVersion: z.literal('v1'),
    kind: z.literal('app'),
    integration: z.enum(['native', 'basic']).default('basic'),
    version: z.string().min(1).optional(),

    metadata: MetadataSchema,
    database: DatabaseSchema.optional(),
    env_mapping: z.record(z.string(), z.string()).optional().default({}),
    containers: z.array(ContainerSchema).min(1),

    secrets: z.array(SecretSchema).optional().default([]),
    credentials: z.array(CredentialSchema).optional().default([]),
    configFiles: z.array(ConfigFileSchema).optional().default([]),
    capabilities: CapabilitiesSchema,
    provides: z.array(ProvidesSchema).optional().default([]),
    wants: z.array(WantSchema).optional().default([]),
    internet: InternetSchema,
    installParams: z.array(InstallParamSchema).optional().default([]),
    forwardAuth: z.enum(['default', 'enabled', 'disabled']).optional(),
    entrances: z.array(EntranceSchema).optional(),
    sso: SSOSchema.optional(),
    backup: BackupSchema.optional(),
    uninstall: UninstallSchema.optional(),
    update: UpdateSchema.optional(),
    detail: DetailSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.containers.length === 1) return true;
      const primaries = data.containers.filter((c) => c.primary);
      return primaries.length === 1;
    },
    { message: 'Multi-container apps must have exactly one primary container' }
  )
  .refine(
    (data) => {
      for (const c of data.containers) {
        if (c.type === 'lxd' && c.source && !c.source.repo) return false;
      }
      return true;
    },
    { message: 'LXD containers with source must specify a repo' }
  )
  .superRefine((data, ctx) => {
    // F2: roleClaim scope coherence check at schema level
    if (data.sso?.adminMapping?.type === 'roleClaim') {
      const claimName = (data.sso.adminMapping as { claimName: string }).claimName;
      const steps = data.sso?.setup?.api?.steps ?? [];
      for (const step of steps) {
        if (!step.body) continue;
        const bodyStr = JSON.stringify(step.body);
        if (/scope/i.test(bodyStr) && !bodyStr.includes(claimName)) {
          ctx.addIssue({
            code: 'custom',
            path: ['sso', 'adminMapping', 'claimName'],
            message: `roleClaim "${claimName}" not found in configure step oauth.scope — admin mapping may fail silently`,
          });
        }
      }
    }
  });

// ─── Catalog Schema ───────────────────────────────────────

export const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().optional(),
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
  apiVersion: z.literal('v1'),
  kind: z.literal('catalog'),
  apps: z.array(CatalogEntrySchema).default([]),
  system: z.array(SystemCatalogEntrySchema).default([]),
});
