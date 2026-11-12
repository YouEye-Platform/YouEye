/**
 * Market engine types.
 *
 * `AppManifest` is the engine's internal app model. It is plain TypeScript: no YAML is ever
 * parsed into it. `app-format/compile.ts` builds it from a parsed `youeye.app.v1` manifest
 * and its setup files.
 */

import type { SetupStep } from './app-format/schema';

// ─── Internal app model ────────────────────────────────────

export interface AppMetadata {
  id: string;
  name: string;
  description: string;
  icon: string;
  iconUrl?: string;
  category: string;
  website?: string;
  developer?: string;
  license?: string;
  sourceCode?: string;
  support?: string;
  docs?: string;
  tagline?: string;
  tags: string[];
  defaultSubdomain: string;
}

interface HealthCheckCommon {
  /** Milliseconds. */
  timeout: number;
  retries: number;
  startPeriod: number;
  autoRestart: boolean;
}

/** An HTTP path on the container, or `pg_isready` as `user` (PostgreSQL sidecars). */
export type HealthCheckSpec =
  | (HealthCheckCommon & { type: 'http'; path: string })
  | (HealthCheckCommon & { type: 'postgres'; user: string });

export interface VolumeSpec {
  name: string;
  /** Mount path inside the container. */
  container: string;
  type: 'config' | 'data' | 'media' | 'cache';
  read_only: boolean;
  /** Shared folder group (`shared:` in the manifest). */
  storageGroup?: string;
  sourceVolume?: string;
  sourcePath?: string;
}

export interface ContainerSource {
  /** Node.js major version of a native app runtime. The app dir is always /opt/app. */
  node: '22' | '24';
  artifactSHA256?: string;
}

export interface ContainerSpec {
  /** Logical name: `main` for the app, the sidecar name otherwise. */
  name: string;
  type: 'lxd' | 'oci';
  primary: boolean;
  image: string;
  port?: number;
  /** OCI entrypoint, shell-quoted from the manifest's argv. */
  command?: string;
  /** Container-specific environment (sidecars); the app's `env` is `AppManifest.env_mapping`. */
  environment: Record<string, string>;
  volumes: VolumeSpec[];
  healthCheck?: HealthCheckSpec;
  source?: ContainerSource;
  network: 'isolated' | 'internet';
}

export interface SecretSpec {
  name: string;
  /** `secrets/<name>`: the file under the app's private directory (/var/lib/youeye/app-<id>). */
  file: string;
  generator: 'password' | 'secretKey' | 'hexToken';
  length: number;
}

export interface CredentialSpec {
  label: string;
  username: string;
  passwordSecret: string;
}

export interface DatabaseSpec {
  mode: 'shared' | 'own' | 'none';
  name?: string;
  user?: string;
  /** Own database: the sidecar that runs it. */
  container?: string;
}

export interface ConfigFileSpec {
  container: string;
  path: string;
  permission: string;
  directoryPermission: string;
  template: string;
}

/**
 * A per-app claim YouEye ID adds to the app's tokens and userinfo when the app requests it as a scope:
 * `admin_value` for YouEye ID admins, `default_value` for everyone else. A list value is sent as a JSON array.
 */
export interface RoleClaim { claim: string; admin_value: string | string[]; default_value: string | string[] }

export interface SSOConfig {
  /** Path on the app; may contain ${sso.slug}. */
  callback_path: string;
  entry_url?: string;
  /** Further callback paths on the app. */
  additional_callbacks: string[];
  backchannel_logout_path?: string;
  /** The group that marks admins (unused when `role_claim` is set). */
  admin_group: string;
  /** Admins are marked by a claim value; the claim is requested as an OAuth scope. */
  role_claim?: RoleClaim;
}

export interface LinkHandlerSpec {
  type: string;
  description: string;
  endpoint?: string;
  triggers: string[];
}

export interface Capabilities {
  notifications?: boolean | 'push';
  smtp?: boolean;
  ai_api?: boolean;
  events?: string[];
  widgets?: boolean;
  info_cards?: boolean;
  settings_panel?: boolean;
  link_handlers?: LinkHandlerSpec[];
}

export interface SurfaceSettingsField {
  key: string;
  type: string;
  label: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  choices?: { value: string; label: string }[];
}

export interface SurfaceSpec {
  id: string;
  kind: 'widget' | 'info-card' | 'timeline-card' | 'notification' | 'settings-panel';
  placement: 'dashboard' | 'timeline' | 'notification-center' | 'app-settings' | 'app-detail';
  name?: string;
  description?: string;
  embedPath: string;
  permissions: string[];
  defaultSize?: { width: number; height: number };
  minSize?: { width: number; height: number };
  maxSize?: { width: number; height: number };
  refreshInterval?: number;
  settingsSchema: SurfaceSettingsField[];
  triggers: string[];
}

export interface ProvidesSpec {
  type: string;
  description?: string;
  port?: number;
  scope: 'user' | 'service';
}

export interface ProxyScopeSpec {
  paths: string[];
  methods: string[];
}

/** A connection this app can make (`connects:` in the manifest). */
export interface WantSpec {
  appId?: string;
  type?: string;
  name: string;
  description?: string;
  defaultPort?: number;
  proxy?: ProxyScopeSpec;
  scope: 'user' | 'service';
  /** Setup file (`setup/<name>.yaml`, `for: connect:<app>`) run when the connection is approved. */
  setup?: string;
}

export interface InternetProxyScopeSpec extends ProxyScopeSpec {
  host: string;
  scope: 'user' | 'service';
}

/**
 * Internet access. `internet: true|false` in the manifest is the app network's NAT (on/off for
 * all of its containers; see ContainerSpec.network) — there is no per-host allowlist. The
 * UI-gateway `proxy:` scopes below are the only per-host mechanism.
 */
export interface InternetSpec {
  proxy: InternetProxyScopeSpec[];
}

export interface BackupSpec {
  ownPostgres?: { container: string; database: string; user?: string };
}

export interface AppDetail {
  longDescription: string;
  releaseNotes?: string;
  screenshots: { path: string; caption?: string }[];
}

export interface ApiSpec {
  base?: string;
  spec?: string;
  auth?: { id: string; principal: string; scheme: string; provision: string }[];
  identity?: string;
}

/** A parsed `youeye.setup.v1` file. Run by the setup runner (`setup-runner.ts`). */
export interface SetupFile {
  /** `setup/<name>.yaml` */
  name: string;
  for: string;
  steps: SetupStep[];
  remove?: SetupStep[];
}

/** The source an installed app was installed from (its frozen copy). */
export interface FrozenAppSource {
  schema: 'youeye.frozen-app.v1';
  /** `youeye-app.yaml` text. */
  manifest: string;
  /** Setup file name → text. */
  setups: Record<string, string>;
  /** Manifest digest (see app-format/digest.ts). */
  digest: string;
  /** Native product releases: the release version, which replaces the manifest's `version`. */
  version?: string;
}

export interface AppManifest {
  integration: 'native' | 'basic';
  version: string;
  requires?: { youeye: string };
  metadata: AppMetadata;
  database?: DatabaseSpec;
  /** Declaration of app-enforced UUID namespaces, never an admission grant. */
  data_ownership?: { per_user: 'identity_uuid' };
  /** The app's environment (`env` plus `sso.env`, `ai.env`, `smtp.env`); main container only. */
  env_mapping: Record<string, string>;
  containers: ContainerSpec[];
  secrets: SecretSpec[];
  credentials: CredentialSpec[];
  configFiles: ConfigFileSpec[];
  capabilities?: Capabilities;
  surfaces: SurfaceSpec[];
  provides: ProvidesSpec[];
  wants: WantSpec[];
  /** The secret (in the app's secret store) that holds its API key. */
  apiKey?: { secret: string };
  internet?: InternetSpec;
  forwardAuth?: 'default' | 'enabled' | 'disabled';
  sso?: SSOConfig;
  backup?: BackupSpec;
  detail?: AppDetail;
  api?: ApiSpec;
  /** Setup files, run by the setup runner. */
  setups: SetupFile[];
  /** The source this model was compiled from; stored as the installed app's frozen copy. */
  frozen?: FrozenAppSource;
}

export interface SystemAppManifest {
  id: string;
  version: string;
  name: string;
  image: string;
  health?: string;
}

export interface MarketCategory {
  id: string;
  label: string;
  icon?: string;
  order?: number;
  tile?: { bg: string; fg: string };
}

export interface MarketCuration {
  spotlight?: { title?: string; apps: string[] };
  collections: { id: string; label: string; apps: string[] }[];
}

/** Bundles: install-and-wire recipes. A bundle is not an app (no subdomain). */
export interface MarketBundle {
  id: string;
  name: string;
  description: string;
  icon?: string;
  category?: string;
  setupSummary?: string;
  /** Install order (providers before consumers). */
  members: string[];
  connections: { from: string; to: string; scope: 'user' | 'service' }[];
  storageGroups: string[];
}

/** One app of a Market source, discovered from its folders. */
export interface CatalogEntry {
  id: string;
  /** Native apps come from their product release on the box's channel. */
  integration: 'native' | 'basic';
  /** App folder (`apps/<id>`) of a container app. */
  path?: string;
}

/** A Market source's catalog: `catalog.yaml` plus what was discovered from its folders. */
export interface Catalog {
  apps: CatalogEntry[];
  bundles: string[];
  system: string[];
  categories: MarketCategory[];
  curation?: MarketCuration;
}

// ─── Install Config ────────────────────────────────────────

export interface InstallConfig {
  appId: string;
  /** Server-resolved authenticated installation actor; never accepted from JSON. */
  admissionActorId?: string;
  /** Explicit authenticated owner request to reuse retained data. */
  adoptRetainedData?: boolean;
  /** Set by the engine after authoritative ownership resolution. */
  admissionInstallationId?: string;
  admissionDataOwnerId?: string;
  admissionResourceOwners?: Record<string, string>;
  /** Stable catalog identity, currently sourceId:itemKind:itemId */
  catalogKey?: string;
  /** Market source selected by the user for catalog installs */
  sourceId?: string;
  sourceName?: string;
  sourceRepoUrl?: string;
  /** In-memory acknowledgement required for the first install of an Added source. */
  acceptUnverifiedPublisher?: boolean;
  /** Second, explicit approval to run the setup files of an app from an Added (URL) source. */
  allowSetup?: boolean;
  /** Resolved manifest location and content hash used for catalog installs */
  manifestPath?: string;
  manifestRepo?: string;
  manifestBranch?: string;
  manifestDigest?: string;
  subdomain: string;
  domain: string;
  /** Custom display name chosen by user at install time */
  customName?: string;
  /** Custom icon chosen by user at install time */
  customIcon?: string;
  /** `youeye-id` when the owner chose YouEye ID sign-in for an app whose SSO needs a setup file */
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
  installationId?: string;
  dataOwnerId?: string;
  shareId?: string;
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

/**
 * `install.json` (`youeye.install.v1`) in /var/lib/youeye/app-<id>/: the installed app's record.
 * Uninstall, updates and repairs decide from it plus the frozen copy, never the live catalog.
 */
export interface InstallMetadata {
  schema?: 'youeye.install.v1';
  appId: string;
  /**
   * The installation id (random, created at install with the app's admission policy). Every
   * Incus instance, custom volume and network the install creates carries it as
   * `user.youeye.installation_id`; cleanup acts only on resources with this tag.
   */
  installationId?: string;
  /** Shared folders (`shared:` groups) the owner approved by installing the app. */
  sharedFolders?: string[];
  /** Set when an uninstall or cleanup could not remove everything; the next one retries. */
  cleanupPending?: boolean;
  /** The box's address changed while the app was stopped: its url-change (and sso) setup runs at the next start. */
  urlChangeSetupPending?: boolean;
  /** Last time the record was written (installedAt is when it was created). */
  updatedAt?: string;
  admissionOwnerId?: string;
  /** Offline root copies; original data owners remain independent of administration. */
  retainedRoots?: {
    schemaVersion: 1;
    state: 'preparing' | 'ready' | 'adopted';
    roots: Array<{ sourceName: string; retainedName: string; ownerId: string; pool: string }>;
  };
  /** Durable lifecycle marker. `installing` is the restart-recovery map; `active` is user-visible state. */
  lifecycleState?: 'installing' | 'active';
  /** Runtime/verifier convergence is required before app services are ready. */
  serviceCredentialState?: 'pending' | 'ready' | 'revoked';
  serviceCredentialDesiredState?: 'running' | 'stopped';
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
  /** Digest of the frozen copy (app-format/digest.ts): `sha256:<hex>`. */
  manifestDigest?: string;
  nativeArtifacts?: Array<{
    productRelease?: import('../releases/product-release').InstalledProductReceipt;
    runtimeUUID?: string;
    containerName: string;
    sourceRepo: string;
    releaseTag: string;
    version: string;
    artifactName: 'standalone.tar';
    sha256: string;
    bytes: number;
    /** `product-release`: bound by the digests of an accepted product release document. */
    verification: 'manifest' | 'product-release';
    productReleaseSHA256?: string;
  }>;
  productReleaseFloors?: import('../releases/product-release').ProductSequenceFloors;
  integration: 'native' | 'basic';
  /** Private namespaces use the immutable OIDC subject; app enforces row privacy. */
  perUserData?: 'identity_uuid';
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
  /** `youeye-id` when YouEye ID sign-in was chosen for an app whose SSO needs a setup file */
  selectedIntegrations?: string[];
  /** SSO entry URL path (e.g. /sso/OID/start/provider) — appended to app URL for direct login */
  ssoEntryUrl?: string;
  /** Database mode from manifest — used by ACL migration to determine postgres access */
  databaseMode?: 'shared' | 'own' | 'none';
  /** Exact shared-database resources recorded before creation for restart-safe cleanup. */
  databaseName?: string;
  databaseUser?: string;
  /**
   * True only once this installation created the shared database and role (or a backup
   * restore created them for it, or it adopted retained data whose record had this set).
   * Delete-data uninstall drops them only when this is set.
   */
  sharedDatabaseCreated?: boolean;
  /** Exact file under the private app directory; preserved by retained-data recovery. */
  databasePasswordFile?: string;
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
}

export interface ContainerStatusInfo {
  name: string;
  status: 'running' | 'stopped' | 'not-found';
  ip?: string;
}

// ─── Variable Context ──────────────────────────────────────
// Values for the `${…}` names of the variable registry (app-format/variables.ts).

export interface VariableContext {
  platform: {
    domain: string;
    version: string;
    locale: string;
    timezone: string;
    site_name: string;
  };
  app: {
    id: string;
    name: string;
    subdomain: string;
    fqdn: string;
    url: string;
    internal_url: string;
  };
  sidecar: Record<string, { host: string; url?: string }>;
  secret: Record<string, string>;
  database: {
    url: string;
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
    admin_group: string;
  };
  identity: {
    name: string;
    external_url: string;
    internal_url: string;
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
    openai_base_url: string;
    anthropic_base_url: string;
    google_base_url: string;
    api_key: string;
    default_model: string;
    utility_model: string;
  };
  youeye: {
    gateway_url: string;
    app_token: string;
  };
  /** Setup files only: values saved by earlier steps. */
  vars?: Record<string, unknown>;
  /** Setup files only: the current item of a for_each step. */
  item?: Record<string, unknown>;
  /** `connect:<app>` setup files only. */
  peer?: { id: string; host: string; url: string; api_key: string };
  self?: { host: string; url: string; api_key: string };
}

// ─── Catalog App (UI display) ──────────────────────────────

export interface MarketApp {
  id: string;
  catalogKey?: string;
  itemKind?: 'app' | 'system';
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
  /** `>=X.Y.Z` when the app needs a newer YouEye than some boxes run. */
  requiresYouEye?: string;
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
  /** Setup files the install runs (shown in the install dialog). */
  setups?: { name: string; for: string }[];
  /** Install-time toggles. Only `youeye-id` (YouEye ID sign-in through a setup file) exists. */
  integrations?: {
    id: string;
    name: string;
    description?: string;
    type: 'identity';
    recommended?: boolean;
    installByDefault?: boolean;
    required?: boolean;
    permissions?: string[];
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
    managedBy: 'control-panel';
  };
}

// ─── Restore Options ─────────────────────────────────────

export interface RestoreOptions {
  skipSecrets: boolean;
  skipDatabase: boolean;
  skipConfigFiles: boolean;
  /** Restore must reinject/probe credentials after all archived runtime data. */
  deferServiceCredentialReadiness?: boolean;
  /** Validated archived identity and runtime intent; not accepted from HTTP input. */
  restoredIdentity?: { installationId: string; ownerId: string };
  /** Authenticated paired backup binding; reuse only after live Pointer validation. */
  restoredManagedAI?: NonNullable<InstallMetadata['aiConnection']>;
  desiredState?: 'running' | 'stopped';
  runtimeImages?: Record<string, string>;
  runtimeInstances?: Record<string, { archivePath: string; pool: string }>;
  /** Verified offline root copies; never accepted from an HTTP request body. */
  retainedRuntimes?: Record<string, { name: string; ownerId: string; pool: string }>;
  /** Imported recovery volumes owned by this transaction and removed on rollback. */
  recoveryCreatedStorage?: string[];
  /** The shared database and role (skipped by `skipDatabase`) were created for this app. */
  sharedDatabaseCreated?: boolean;
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
