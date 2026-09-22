/**
 * Zod schemas for youeye-app.yaml manifest validation.
 * Validates app manifests fetched from the Market catalog or from repo URLs.
 *
 * Single format — apiVersion: v1. No backwards compatibility needed (pre-beta).
 *
 * Key structural decisions:
 *   - `integration: native|basic` — native = LXD containers from release artifacts, basic = OCI images
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
  // Richer store metadata (optional so existing manifests keep parsing; the 5 seeded apps
  // + new apps should set developer + license). developer/license render as the app's
  // attribution + a license badge; sourceCode/support/docs render as detail-page links.
  developer: z.string().optional(),
  license: z.string().optional(),
  sourceCode: z.string().url().optional(),
  support: z.string().url().optional(),
  docs: z.string().url().optional(),
  tagline: z.string().optional(),
  tags: z.array(z.string()).default([]),
  defaultSubdomain: z.string().min(1),
});

export const SystemMetadataSchema = MetadataSchema.omit({ defaultSubdomain: true });

// ─── Health Check ──────────────────────────────────────────

export const HealthCheckSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('http'),
    path: z.string().default('/'),
    timeout: z.number().int().positive().default(120_000),
    retries: z.number().int().positive().default(3),
    startPeriod: z.number().int().nonnegative().default(0),
    autoRestart: z.boolean().default(true),
  }),
  z.object({
    type: z.literal('postgres'),
    user: z.string().min(1),
    timeout: z.number().int().positive().default(60_000),
    retries: z.number().int().positive().default(3),
    startPeriod: z.number().int().nonnegative().default(0),
    autoRestart: z.boolean().default(true),
  }),
]);

// ─── Volume ───────────────────────────────────────────────

export const VolumeSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'Volume name must be lowercase alphanumeric with dashes'),
  container: z.string().min(1),
  type: z.enum(['config', 'data', 'media', 'cache']).default('data'),
  containers: z.array(z.string()).optional(),
  read_only: z.boolean().default(false),
  // Shared storage group — apps that declare the same group mount the same
  // Incus custom filesystem volume. It is retained until the final consumer is removed.
  storageGroup: z.string().regex(/^[a-z0-9-]+$/, 'storageGroup must be lowercase alphanumeric with dashes').optional(),
  /** Re-attach a subpath from another named volume in this container. */
  sourceVolume: z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/).optional(),
  sourcePath: z.string().regex(/^[a-zA-Z0-9._/-]+$/).optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.sourceVolume) !== Boolean(value.sourcePath)) {
    ctx.addIssue({ code: 'custom', message: 'sourceVolume and sourcePath must be declared together' });
  }
  if (value.sourcePath && (value.sourcePath.startsWith('/') || value.sourcePath.split('/').includes('..'))) {
    ctx.addIssue({ code: 'custom', message: 'sourcePath must remain inside its custom volume' });
  }
});

// ─── Post-Deploy Step ─────────────────────────────────────

export const PostDeployStepSchema = z.object({
  exec: z.string().min(1),
  timeout: z.number().int().positive().default(30_000),
});

// ─── Container Source (LXD-only release repo deploy) ───────

export const ContainerSourceSchema = z.object({
  repo: z.string().min(1),
  nodeVersion: z.string().optional(),
  appDir: z.string().default('/opt/app'),
  tagPrefix: z.string().optional(),
  artifactSHA256: z.string().regex(/^[0-9a-fA-F]{64}$/, 'artifactSHA256 must be a SHA-256 digest').optional(),
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
  container: z.string().regex(/^[a-z0-9-]+$/, 'Config file container must match a manifest container name'),
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

// ─── Integrations ─────────────────────────────────────────

export const IntegrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Integration id must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  description: z.string().optional(),
  type: z.enum(['identity', 'plugin', 'addon', 'script']).default('addon'),
  recommended: z.boolean().optional().default(false),
  installByDefault: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  target: z.object({
    appId: z.string().min(1).optional(),
    version: z.string().optional(),
  }).optional(),
  permissions: z.array(z.string()).optional().default([]),
  sso: SSOSchema.optional(),
});

export const IntegrationManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('integration'),
  version: z.string().min(1).optional(),
  type: z.enum(['identity', 'plugin', 'addon', 'script']).default('addon'),
  recommended: z.boolean().optional().default(false),
  installByDefault: z.boolean().optional().default(false),
  required: z.boolean().optional().default(false),
  metadata: MetadataSchema.extend({
    defaultSubdomain: z.string().optional().default(''),
  }),
  target: z.object({
    appId: z.string().min(1),
    appName: z.string().optional(),
    version: z.string().optional(),
  }),
  permissions: z.array(z.string()).optional().default([]),
  sso: SSOSchema.optional(),
  uninstall: SSOSetupSchema.optional(),
  rollback: SSOSetupSchema.optional(),
  detail: z.object({
    longDescription: z.string().min(1),
    screenshots: z.array(z.object({
      path: z.string().min(1),
      caption: z.string().optional(),
    })).default([]),
  }).optional(),
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

// ─── Surfaces (unified app embeds) ────────────────────────

const SurfaceSizeSchema = z.object({
  width: z.number().positive(),
  height: z.number().positive(),
});

const SurfaceSettingsFieldSchema = z.object({
  key: z.string().min(1),
  type: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  choices: z.array(z.object({
    value: z.string(),
    label: z.string(),
  })).optional(),
});

export const UserPreferenceFieldSchema = SurfaceSettingsFieldSchema.extend({
  type: z.enum(['string', 'number', 'boolean', 'select', 'password']).optional().default('string'),
});

export const AppSettingsSchema = z.object({
  schema: z.array(UserPreferenceFieldSchema).optional().default([]),
}).optional();

export const SurfaceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'Surface id must be lowercase alphanumeric with dashes'),
  kind: z.enum(['widget', 'info-card', 'timeline-card', 'notification', 'settings-panel']),
  placement: z.enum(['dashboard', 'timeline', 'notification-center', 'app-settings', 'app-detail']),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  embedPath: z.string().min(1),
  permissions: z.array(z.string()).optional().default([]),
  defaultSize: SurfaceSizeSchema.optional(),
  minSize: SurfaceSizeSchema.optional(),
  maxSize: SurfaceSizeSchema.optional(),
  refreshInterval: z.number().int().positive().optional(),
  settingsSchema: z.array(SurfaceSettingsFieldSchema).optional().default([]),
  triggers: z.array(z.string().min(1)).optional().default([]),
});

// ─── Provides (capability declarations) ──────────────────

export const ProvidesSchema = z.object({
  type: z.string().min(1),
  description: z.string().optional(),
  port: z.number().int().positive().optional(),
  // Connection scope (distinct from the internet-proxy scope below): `user` = each user
  // grants the connection individually; `service` = a single server-wide (owner) grant.
  // External-app integrations are typically `service`; native UI-gateway apps `user`.
  scope: z.enum(['user', 'service']).optional().default('user'),
});

// ─── Proxy Scopes ────────────────────────────────────────

export const ProxyScopeSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
  methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])).optional().default(['GET']),
});

export const InternetProxyScopeSchema = ProxyScopeSchema.extend({
  host: z.string().min(1),
  scope: z.enum(['user', 'service']).optional().default('user'),
});

// ─── Wants (app-to-app connection declarations) ──────────

/** System container IDs — never valid bridge/want targets */
const SYSTEM_APP_IDS = [
  'postgres', 'caddy', 'pihole', 'control', 'ui',
];

// Wire recipe — app-config choreography run when a connection is APPROVED (by a bundle's
// auto-approve OR a user approving a suggestion for two separately-installed apps). Reuses
// the SSO step format (api: REST calls with var interpolation + extraction; cli: container
// shell). The wire-runner injects ${wire.from.*}/${wire.to.*} (host, port, apiKey) into the
// context. Defined on the CONSUMER's `want` — the capability lives with the apps, not the bundle.
export const WireSchema = z.object({
  api: z.object({ steps: z.array(SSOStepSchema).default([]) }).optional(),
  cli: z.object({ steps: z.array(SSOCliStepSchema).default([]) }).optional(),
});

export const WantSchema = z.object({
  appId: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  defaultPort: z.number().int().positive().optional(),
  proxy: ProxyScopeSchema.optional(),
  // Connection scope declared by the CONSUMER for this want (authoritative for grant
  // routing): `user` = per-user grant; `service` = one server-wide (owner) grant.
  scope: z.enum(['user', 'service']).optional().default('user'),
  // Optional app-config recipe run when this connection is approved (see WireSchema).
  wire: WireSchema.optional(),
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
  proxy: z.array(InternetProxyScopeSchema).optional().default([]),
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
  user: z.string().min(1).optional(),
});

export const BackupSchema = z.object({
  ownPostgres: OwnPostgresSchema.optional(),
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
  required: z.boolean().optional().default(true),
  idempotencyKey: z.string().optional(),
  description: z.string().optional(),
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

export const UpdatePlanSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('update-plan'),
  appId: z.string().min(1),
  version: z.string().optional(),
  minPlatformVersion: z.string().optional(),
  migrations: z.array(MigrationSchema).optional().default([]),
});

export const SystemAppManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('system-app'),
  version: z.string().min(1),
  metadata: SystemMetadataSchema,
  image: z.string().min(1),
  containerName: z.string().optional(),
  healthCheck: HealthCheckSchema.optional(),
  minPlatformVersion: z.string().optional(),
  update: UpdateSchema.optional(),
});

// ─── Detail (app detail page) ─────────────────────────────

export const DetailScreenshotSchema = z.object({
  path: z.string().min(1),
  caption: z.string().optional(),
});

export const DetailSchema = z.object({
  longDescription: z.string().min(1),
  /** "What's new" — release notes for the current version, shown on the detail page. */
  releaseNotes: z.string().optional(),
  screenshots: z.array(DetailScreenshotSchema).default([]),
});

// ─── Reconfigure hooks ────────────────────────────────────
// Optional commands the reconfigure engine runs inside app containers after a
// server URL change (env/config already updated, containers restarted).
// Example: flush a sidecar cache that persists a stale OIDC discovery document
// (Nextcloud's valkey caches the authorize endpoint across restarts).

export const ReconfigureCommandSchema = z.object({
  container: z.string().min(1),
  command: z.string().min(1),
  timeout: z.number().int().positive().optional().default(30000),
});

export const ReconfigureSchema = z.object({
  commands: z.array(ReconfigureCommandSchema).optional().default([]),
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
    settings: AppSettingsSchema,
    preferences: z.array(UserPreferenceFieldSchema).optional().default([]),
    launchPreferences: z.array(UserPreferenceFieldSchema).optional().default([]),
    surfaceSchemaVersion: z.number().int().positive().optional().default(1),
    surfaces: z.array(SurfaceSchema).optional().default([]),
    provides: z.array(ProvidesSchema).optional().default([]),
    wants: z.array(WantSchema).optional().default([]),
    // How the wire-runner reads this app's API key (for connection wiring). `file` is read
    // from the running container via shell; `pattern` is a regex with one capture group.
    // e.g. *arr apps: { file: /config/config.xml, pattern: "<ApiKey>([a-f0-9]+)</ApiKey>" }.
    apiKey: z.object({ file: z.string().min(1), pattern: z.string().min(1) }).optional(),
    internet: InternetSchema,
    installParams: z.array(InstallParamSchema).optional().default([]),
    forwardAuth: z.enum(['default', 'enabled', 'disabled']).optional(),
    entrances: z.array(EntranceSchema).optional(),
    sso: SSOSchema.optional(),
    integrations: z.array(IntegrationSchema).optional().default([]),
    backup: BackupSchema.optional(),
    reconfigure: ReconfigureSchema.optional(),
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

const CatalogRepositoryRefSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
  .refine((ref) => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/'), 'Unsafe repository ref');

export const CatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().optional(),
  repo: z.string().optional(),
  branch: CatalogRepositoryRefSchema.optional(),
  /**
   * New per-app folder layout: the app's folder in this store (e.g. `apps/redlib`). The
   * manifest is read from `<path>/<manifest>` and assets (icon.svg, screenshots/) are
   * resolved relative to `<path>/`. Coexists with the legacy `file:`/`repo:` fields — an
   * entry uses exactly one of `path` | `file` | `repo`.
   */
  path: z.string().optional(),
  manifest: z.string().default('youeye-app.yaml'),
  integration: z.enum(['native', 'basic']).default('basic'),
  latestVersion: z.string().optional(),
  minPlatformVersion: z.string().optional(),
});

// store.yaml — per-source descriptor (the new market layout). Official sources keep
// un-namespaced app ids; third-party stores namespace by their `id`. Parsed when present;
// absent stores fall back to the configured source metadata (legacy layout).
export const StoreDescriptorSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('store'),
  id: z.string().min(1),
  name: z.string().min(1),
  official: z.boolean().optional().default(false),
});

export const SystemCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
});

export const IntegrationCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().optional(),
  repo: z.string().optional(),
  branch: CatalogRepositoryRefSchema.optional(),
  manifest: z.string().default('youeye-integration.yaml'),
  latestVersion: z.string().optional(),
  targetAppId: z.string().optional(),
});

export const UpdatePlanCatalogEntrySchema = z.object({
  id: z.string().min(1),
  appId: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
});

// Market category metadata — drives the category pills, section headers, ordering, and
// fallback tile colours/icons in the Market UI. Data-driven: adding a category is a
// catalog.yaml change only, no code change.
export const CategorySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** Lucide icon name (e.g. "briefcase"); rendered in the category pill. */
  icon: z.string().optional(),
  /** Sort order for pills + sections (ascending; unset sorts last). */
  order: z.number().optional(),
  /** Soft tile colours for apps in this category that have no icon image. */
  tile: z.object({ bg: z.string(), fg: z.string() }).optional(),
});

// Curation — editorial layout for the Market home, data-driven. `spotlight` is the
// "Built for <server>" strip (ordered app ids); `collections` are extra labeled rows.
// Apps listed here are shown in their curated strip instead of the generic category
// browse, so they are not listed twice.
export const SpotlightSchema = z.object({
  title: z.string().optional(),
  apps: z.array(z.string()).default([]),
});
export const CollectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  apps: z.array(z.string()).default([]),
});
export const CurationSchema = z.object({
  spotlight: SpotlightSchema.optional(),
  collections: z.array(CollectionSchema).default([]),
});

// Bundles — curated, install-and-wire recipes. A bundle is NOT a container/app (no
// subdomain); it installs a set of member apps in order and arrives pre-wired (shared
// storage groups + auto-approved service-scoped connections). The full definition lives
// in `bundles/<id>/bundle.yaml`, referenced by id+file from the catalog `bundles:` list.
export const BundleConnectionSchema = z.object({
  from: z.string().min(1), // consumer app id
  to: z.string().min(1),   // provider app id
  scope: z.enum(['user', 'service']).optional().default('service'),
});

export const BundleManifestSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('bundle'),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  /** Lucide icon name for the bundle card. */
  icon: z.string().optional(),
  category: z.string().optional(),
  /** Plain-language "what this sets up", shown on the bundle card. */
  setupSummary: z.string().optional(),
  /** Ordered app ids = install/dependency order (providers before consumers). */
  members: z.array(z.string().min(1)).min(1),
  /** App→app connections to auto-approve after install (install-and-wire engine). */
  connections: z.array(BundleConnectionSchema).default([]),
  /** Shared storage groups the bundle relies on (members' volumes mount them). */
  storageGroups: z.array(z.string()).default([]),
});

export const BundleCatalogEntrySchema = z.object({
  id: z.string().min(1),
  file: z.string().min(1),
  latestVersion: z.string().optional(),
});

export const CatalogSchema = z.object({
  apiVersion: z.literal('v1'),
  kind: z.literal('catalog'),
  apps: z.array(CatalogEntrySchema).default([]),
  system: z.array(SystemCatalogEntrySchema).default([]),
  integrations: z.array(IntegrationCatalogEntrySchema).default([]),
  updatePlans: z.array(UpdatePlanCatalogEntrySchema).default([]),
  categories: z.array(CategorySchema).default([]),
  curation: CurationSchema.optional(),
  bundles: z.array(BundleCatalogEntrySchema).default([]),
});
