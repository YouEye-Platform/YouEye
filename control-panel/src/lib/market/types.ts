/**
 * Market engine types.
 * Inferred from Zod schemas + runtime types for install flow.
 */

import type { z } from 'zod/v4';
import type {
  AppManifestSchema,
  MetadataSchema,
  ContainerSchema,
  ContainerSourceSchema,
  SecretSchema,
  CredentialSchema,
  DatabaseSchema,
  ConfigFileSchema,
  CapabilitiesSchema,
  AdminMappingSchema,
  SSOSchema,
  SSOStepSchema,
  SSOSetupSchema,
  SSOCliStepSchema,
  IntegrationSchema,
  IntegrationManifestSchema,
  BackupSchema,
  UninstallSchema,
  UpdateSchema,
  SystemAppManifestSchema,
  UpdateHookStepSchema,
  MigrationSchema,
  MigrationStepSchema,
  HealthCheckSchema,
  CatalogSchema,
  CategorySchema,
  CurationSchema,
  BundleManifestSchema,
  StoreDescriptorSchema,
  CatalogEntrySchema,
  SystemCatalogEntrySchema,
  IntegrationCatalogEntrySchema,
  UpdatePlanSchema,
  UpdatePlanCatalogEntrySchema,
  DetailSchema,
  DetailScreenshotSchema,
  InstallParamSchema,
  ProvidesSchema,
  WantSchema,
  ProxyScopeSchema,
  InternetProxyScopeSchema,
  InternetSchema,
  PostDeployStepSchema,
  VolumeSchema,
  SurfaceSchema,
  UserPreferenceFieldSchema,
  AppSettingsSchema,
} from './schema';

// ─── Manifest Types (from Zod) ─────────────────────────────

export type AppManifest = z.infer<typeof AppManifestSchema>;
export type AppMetadata = z.infer<typeof MetadataSchema>;
export type ContainerSpec = z.infer<typeof ContainerSchema>;
export type ContainerSource = z.infer<typeof ContainerSourceSchema>;
export type SecretSpec = z.infer<typeof SecretSchema>;
export type CredentialSpec = z.infer<typeof CredentialSchema>;
export type DatabaseSpec = z.infer<typeof DatabaseSchema>;
export type ConfigFileSpec = z.infer<typeof ConfigFileSchema>;
export type AdminMapping = z.infer<typeof AdminMappingSchema>;
export type SSOConfig = z.infer<typeof SSOSchema>;
export type SSOStep = z.infer<typeof SSOStepSchema>;
export type SSOSetup = z.infer<typeof SSOSetupSchema>;
export type SSOCliStep = z.infer<typeof SSOCliStepSchema>;
export type IntegrationSpec = z.infer<typeof IntegrationSchema>;
export type IntegrationManifest = z.infer<typeof IntegrationManifestSchema>;
export type SystemAppManifest = z.infer<typeof SystemAppManifestSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type BackupSpec = z.infer<typeof BackupSchema>;
export type UninstallSpec = z.infer<typeof UninstallSchema>;
export type UpdateSpec = z.infer<typeof UpdateSchema>;
export type UpdateHookStep = z.infer<typeof UpdateHookStepSchema>;
export type MigrationSpec = z.infer<typeof MigrationSchema>;
export type MigrationStep = z.infer<typeof MigrationStepSchema>;
export type HealthCheckSpec = z.infer<typeof HealthCheckSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
export type MarketCategory = z.infer<typeof CategorySchema>;
export type MarketCuration = z.infer<typeof CurationSchema>;
export type MarketBundle = z.infer<typeof BundleManifestSchema>;
export type StoreDescriptor = z.infer<typeof StoreDescriptorSchema>;
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;
export type SystemCatalogEntry = z.infer<typeof SystemCatalogEntrySchema>;
export type IntegrationCatalogEntry = z.infer<typeof IntegrationCatalogEntrySchema>;
export type UpdatePlan = z.infer<typeof UpdatePlanSchema>;
export type UpdatePlanCatalogEntry = z.infer<typeof UpdatePlanCatalogEntrySchema>;
export type AppDetail = z.infer<typeof DetailSchema>;
export type DetailScreenshot = z.infer<typeof DetailScreenshotSchema>;
export type InstallParam = z.infer<typeof InstallParamSchema>;
export type ProvidesSpec = z.infer<typeof ProvidesSchema>;
export type WantSpec = z.infer<typeof WantSchema>;
export type ProxyScopeSpec = z.infer<typeof ProxyScopeSchema>;
export type InternetProxyScopeSpec = z.infer<typeof InternetProxyScopeSchema>;
export type InternetSpec = z.infer<typeof InternetSchema>;
export type PostDeployStep = z.infer<typeof PostDeployStepSchema>;
export type VolumeSpec = z.infer<typeof VolumeSchema>;
export type SurfaceSpec = z.infer<typeof SurfaceSchema>;
export type UserPreferenceField = z.infer<typeof UserPreferenceFieldSchema>;
export type AppSettingsSpec = z.infer<typeof AppSettingsSchema>;

// ─── Install Config ────────────────────────────────────────

export interface InstallConfig {
  appId: string;
  /** Stable catalog identity, currently sourceId:itemKind:itemId */
  catalogKey?: string;
  /** Market source selected by the user for catalog installs */
  sourceId?: string;
  sourceName?: string;
  sourceRepoUrl?: string;
  /** In-memory acknowledgement required for the first install of an Added source. */
  acceptUnverifiedPublisher?: boolean;
  /** Resolved manifest location and content hash used for catalog installs */
  manifestPath?: string;
  manifestRepo?: string;
  manifestBranch?: string;
  manifestDigest?: string;
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
  /** Connections approved at install time (from manifest.wants) */
  approvedConnections?: ApprovedConnection[];
  /** Optional Market integrations selected during install */
  selectedIntegrations?: string[];
  /** User's install-time choice for platform account-login protection */
  protectWithAccountLogin?: boolean;
  /**
   * Explicit install-time choice for the forward-auth proxy gate, kept SEPARATE from
   * `protectWithAccountLogin`. For apps that do their own YouEye ID login (native SSO or
   * an identity integration), `protectWithAccountLogin` controls that login/integration —
   * the forward-auth gate is an optional extra gate the owner can turn on here (default
   * off). For apps with no login of their own, the gate IS the login and is driven by
   * `protectWithAccountLogin`; this field is left undefined.
   */
  forwardAuthGate?: boolean;
  /** True when a selected standalone identity Integration will provide app-native SSO after base install */
  plannedNativeIdentityIntegration?: boolean;
  installedIntegrations?: {
    id: string;
    sourceId?: string;
    sourceName?: string;
    manifestPath?: string;
    manifestRepo?: string;
    manifestBranch?: string;
    manifestDigest?: string;
    installedAt: string;
  }[];
  /** User's explicit internet/LAN access choice at install time */
  allowInternet?: boolean;
  /**
   * AI Settings choice. The route overwrites owner identity and all runtime
   * fields server-side; callers may select only enabled/modelGroupId.
   */
  aiSettings?: {
    enabled: boolean;
    modelGroupId?: string;
    ownerUserId?: string;
    ownerDisplayName?: string;
    /** In-memory only during install; never written to metadata or logs. */
    runtimeCredential?: string;
    externalInstallationId?: string;
    pointerInstallationId?: string;
    pointerInstanceId?: string;
    pointerOwnerId?: string;
    groupName?: string;
    keyPreview?: string;
  };
  /** App data placement. Hidden when only one eligible pool exists. */
  storage?: {
    pool?: string;
    placements?: Partial<Record<'config' | 'data' | 'media', string>>;
  };
}

/** A connection approved by the user at install time */
export interface ApprovedConnection {
  targetAppId: string;
  approved: boolean;
}

// ─── Install Metadata (persisted to install.json) ──────────

export interface ContainerMeta {
  name: string;
  containerName: string;
  type: 'lxd' | 'oci';
  /** True when this is the app's primary user-facing container */
  primary?: boolean;
  /** Optional lifecycle role used to order app start/stop operations */
  role?: 'app' | 'database' | 'cache' | 'worker' | 'sidecar';
  /** Network mode from manifest: 'isolated' (default) or 'internet' */
  network?: 'isolated' | 'internet';
  /** Primary listening port from manifest (used by health checker) */
  port?: number;
  /** Health check config from manifest (used by background health checker) */
  healthCheck?: {
    type: 'http' | 'postgres' | 'none';
    path?: string;
    timeout?: number;
    retries?: number;
    startPeriod?: number;
    autoRestart?: boolean;
  };
}

export interface CredentialMeta {
  label: string;
  username: string;
  passwordSecret: string;
}

export interface StorageVolumeMeta {
  appId: string;
  name: string;
  logicalName: string;
  pool: string;
  containerName: string;
  containerPath: string;
  type: 'config' | 'data' | 'media';
  sharedGroup?: string;
  sourcePath?: string;
  attachmentOnly?: boolean;
  readOnly: boolean;
  backup: true;
}

export interface InstallMetadata {
  appId: string;
  /** Durable lifecycle marker. `installing` is the restart-recovery map; `active` is user-visible state. */
  lifecycleState?: 'installing' | 'active';
  /** Restores retain pre-existing datasets when an interrupted install is reconciled. */
  recoveryPreserveData?: boolean;
  /** Exact Incus custom-volume ownership and attachment map. */
  storageVolumes?: StorageVolumeMeta[];
  catalogKey?: string;
  itemKind?: 'app' | string;
  sourceId?: string;
  sourceName?: string;
  sourceRepoUrl?: string;
  manifestPath?: string;
  manifestRepo?: string;
  manifestBranch?: string;
  manifestDigest?: string;
  nativeArtifacts?: Array<{
    containerName: string;
    sourceRepo: string;
    releaseTag: string;
    version: string;
    artifactName: 'standalone.tar';
    sha256: string;
    bytes: number;
    signature: 'unsigned' | 'verified-development';
    signatureKeyId?: string;
  }>;
  integration: 'native' | 'basic';
  subdomain: string;
  domain: string;
  enableSSO: boolean;
  forwardAuthEnabled?: boolean;
  protectWithAccountLogin?: boolean;
  installedAt: string;
  installedVersion?: string;
  /** Catalog version at install time — persisted so update detection never
   *  starts from a null baseline (0.5.5 install-metadata fix) */
  catalogVersion?: string;
  /** False when the owner intentionally turned this app off */
  enabled?: boolean;
  /** Persisted desired runtime state for watchdog/reboot reconciliation */
  desiredState?: 'running' | 'stopped';
  /** Owner-controlled automatic recovery policy; defaults to enabled. */
  autoRestart?: boolean;
  /** Durable route description used by reconciliation to recreate every entrance. */
  entrances?: {
    name: string;
    path: string;
    port: number;
    container?: string;
    protocol?: 'http' | 'tcp';
    authLevel?: 'private' | 'public' | 'internal' | 'none';
    stripPath?: boolean;
  }[];
  disabledAt?: string;
  disabledBy?: string;
  lastPowerAction?: 'start' | 'stop' | 'restart';
  /** Crash-safe lifecycle intent and per-container convergence record. */
  lifecycleOperation?: {
    id: string;
    action: 'start' | 'stop' | 'restart';
    desiredState: 'running' | 'stopped';
    state: 'applying' | 'completed' | 'partial';
    actor: string;
    startedAt: string;
    updatedAt: string;
    error?: string;
    containers: Array<{
      name: string;
      bootAutostart: 'pending' | 'applied';
      runtime: 'pending' | 'applied';
    }>;
  };
  containers: ContainerMeta[];
  ssoSlug?: string;
  ssoClientId?: string;
  forwardAuthSlug?: string;
  manifestSource?: string;
  /** Admin-visible default credentials (references secrets by name) */
  credentials?: CredentialMeta[];
  /** Optional Market integrations selected during install */
  selectedIntegrations?: string[];
  /** Optional Market integrations successfully applied to this install */
  installedIntegrations?: {
    id: string;
    sourceId?: string;
    sourceName?: string;
    manifestPath?: string;
    manifestRepo?: string;
    manifestBranch?: string;
    manifestDigest?: string;
    installedAt: string;
  }[];
  /** SSO entry URL path (e.g. /sso/OID/start/provider) — appended to app URL for direct login */
  ssoEntryUrl?: string;
  /** Database mode from manifest — used by ACL migration to determine postgres access */
  databaseMode?: 'shared' | 'own' | 'none';
  /** Exact shared-database resources recorded before creation for restart-safe cleanup. */
  databaseName?: string;
  databaseUser?: string;
  /** Whether this app has SSO configured — used by ACL migration to determine identity access */
  hasSSO?: boolean;
  /** Capability types this app provides (from manifest `provides` field) */
  provides?: ProvidesSpec[];
  /** Connection wants this app declares (from manifest `wants` field). Persisted so the
   *  reverse-scan can suggest connections to existing consumers when a provider installs. */
  wants?: WantSpec[];
  /** Non-secret Pointer lifecycle state for a Market-managed AI connection. */
  aiConnection?: {
    externalInstallationId: string;
    pointerInstallationId: string;
    pointerInstanceId: string;
    ownerUserId: string;
    pointerOwnerId: string;
    modelGroupId: string;
    groupName: string;
    keyPreview: string;
    credentialSecret: 'pointer_api_key';
    defaultModel: 'default';
    state: 'active' | 'disabled' | 'needs_attention';
  };
  /** Crash-recovery owner recorded before Pointer provisioning begins. */
  aiConnectionPending?: {
    externalInstallationId: string;
    ownerUserId: string;
  };
  /** @deprecated All apps use per-app bridge networking now. Kept for install.json compat. */
  usePerAppBridge?: boolean;
  /** Required migration gates already completed for this install. */
  appliedMigrations?: {
    key: string;
    fromVersion: string;
    toVersion: string;
    appliedAt: string;
    source?: 'manifest' | 'update-plan';
  }[];
}

// ─── Install Events (SSE) ──────────────────────────────────

export interface InstallEvent {
  step: number;
  totalSteps: number;
  status: 'running' | 'success' | 'error' | 'skipped' | 'warning';
  message: string;
  detail?: string;
  phase?: 'install' | 'verify';
  duration?: number;
  errorContext?: {
    url?: string;
    method?: string;
    statusCode?: number;
    responseBody?: string;
    resolvedVars?: Record<string, string>;
    suggestion?: string;
  };
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
  installedVersion?: string;
  catalogVersion?: string | null;
  updateAvailable?: boolean;
  healthStatus?: 'healthy' | 'unhealthy' | 'unknown';
  healthCheckedAt?: string | null;
  storageStatus?: 'connected' | 'disconnected';
  storageDetail?: string;
  forwardAuthEnabled?: boolean;
  catalogKey?: string;
  sourceId?: string;
  sourceName?: string;
  sourceRepoUrl?: string;
  manifestPath?: string;
  manifestRepo?: string;
  manifestBranch?: string;
  manifestDigest?: string;
  installedIntegrations?: {
    id: string;
    sourceId?: string;
    sourceName?: string;
    manifestPath?: string;
    manifestRepo?: string;
    manifestBranch?: string;
    manifestDigest?: string;
    installedAt: string;
  }[];
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
    url: string;
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
    slug: string;
    issuer: string;
    discovery_url: string;
    authorize_url: string;
    client_id: string;
    client_secret: string;
    callback_url: string;
    logout_url: string;
  };
  identity: {
    externalUrl: string;
    internalUrl: string;
    name: string;
    issuer: string;
    discoveryUrl: string;
  };
  smtp: {
    host: string;
    port: string;
    user: string;
    password: string;
    from: string;
    security: string;
  };
  ai: {
    enabled: boolean;
    openaiBaseUrl: string;
    anthropicBaseUrl: string;
    googleBaseUrl: string;
    apiKey: string;
    defaultModel: string;
    groupId: string;
  };
  secrets: Record<string, string>;
  installParams: Record<string, string>;

  // Set only during connection wiring — the two endpoints of the connection being approved,
  // with resolved internal host/port and API key. Recipes use ${wire.to.apiKey}, ${wire.from.host}, …
  wire?: {
    from: { id: string; host: string; port?: number; apiKey?: string; url?: string };
    to: { id: string; host: string; port?: number; apiKey?: string; url?: string };
  };

  // Manifest aliases retained by the current v1 schema.
  install: { url: string; subdomain: string; domain: string };
  container: { ip: string; port: number };
}

// ─── Catalog App (UI display) ──────────────────────────────

export interface MarketApp {
  id: string;
  catalogKey?: string;
  itemKind?: 'app' | 'integration' | 'system';
  sourceId?: string;
  sourceName?: string;
  sourceRepoUrl?: string;
  manifestPath?: string;
  manifestRepo?: string;
  manifestBranch?: string;
  manifestDigest?: string;
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
  developer?: string;
  license?: string;
  sourceCode?: string;
  support?: string;
  docs?: string;
  tagline?: string;
  tags: string[];
  detail?: {
    longDescription: string;
    releaseNotes?: string;
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
  integrations?: {
    id: string;
    name: string;
    description?: string;
    type: 'identity' | 'plugin' | 'addon' | 'script';
    recommended?: boolean;
    installByDefault?: boolean;
    required?: boolean;
    permissions?: string[];
    itemKind?: 'integration';
    sourceId?: string;
    sourceName?: string;
    sourceRepoUrl?: string;
    manifestPath?: string;
    manifestRepo?: string;
    manifestBranch?: string;
    manifestDigest?: string;
    hasUninstall?: boolean;
  }[];
  target?: {
    appId: string;
    appName?: string;
    version?: string;
  };
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
    ai_api?: boolean;
    link_handlers?: Array<{ type: string; description: string; endpoint?: string; triggers: string[] }>;
  };
  surfaces?: SurfaceSpec[];
  system?: {
    image: string;
    containerName?: string;
    minPlatformVersion?: string;
    managedBy: 'control-panel';
  };
}

// ─── Restore Options ─────────────────────────────────────

export interface RestoreOptions {
  skipSecrets: boolean;
  skipDatabase: boolean;
  skipConfigFiles: boolean;
  runtimeImages?: Record<string, string>;
  runtimeInstances?: Record<string, { archivePath: string; pool: string }>;
  /** Imported recovery volumes owned by this transaction and removed on rollback. */
  recoveryCreatedStorage?: string[];
}

// ─── Uninstall Options ────────────────────────────────────

export interface UninstallOptions {
  keepData: boolean;
}

// ─── Uninstall Verification ───────────────────────────────

export interface UninstallVerification {
  containerRemoved: boolean;
  networkRemoved: boolean;
  leaseReleased: boolean;
  caddyRouteRemoved: boolean;
  identityClientRemoved: boolean;
  dnsRemoved: boolean;
  databaseDropped: boolean | null;
  dataRemoved: boolean | null;
  warnings: string[];
}

// ─── Orphan Resource ──────────────────────────────────────

export type OrphanType = 'caddy-route' | 'postgres-db' | 'dns-entry' | 'storage-volume' | 'container';

export interface OrphanResource {
  type: OrphanType;
  identifier: string;
  detail?: string;
  action: 'can-remove';
}
