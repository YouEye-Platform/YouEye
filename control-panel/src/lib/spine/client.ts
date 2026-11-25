/**
 * Spine API Client
 * 
 * Communicates with Spine via Unix socket for:
 * - PAM authentication
 * - System status
 * - Updates
 */

import http from 'http';
import type { BackupEncryption, BackupSourceIdentity, SpineBackupStatus } from '@/lib/backup/types';

const SPINE_SOCKET = '/var/run/youeye/youeye.sock';
const UNREACHABLE_SOCKET_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);

/**
 * The request did not get Spine's answer: the socket is not there or refused (`ENOENT`, `ECONNREFUSED`, `ENOTSOCK`),
 * closed before Spine answered, or Spine did not answer within the request's limit (`ETIMEDOUT`). Spine did not
 * refuse anything; what it did with the request is not known.
 */
export class SpineTransportError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly socketPath: string,
  ) {
    super(message);
    this.name = 'SpineTransportError';
  }
}

interface SpineAuthResponse {
  authenticated: boolean;
  username: string;
  groups: string[];
}

interface SpineVersionResponse {
  /** The binary's own baked value (a build name up to 0.6.12, the line from 0.6.13). Never shown. */
  version: string;
  service: string;
  /** The installed release's version (Spine from 0.6.12 on); what callers show and compare. */
  release?: string;
  /** The git tree this Spine binary was built from (from 0.6.12 builds on). */
  source_tree?: string;
}

export interface SpineRuntimeCapabilities {
  spine_update: boolean;
  system_update: boolean;
  incus_update: boolean;
  control_update: boolean;
  ui_update: boolean;
  app_update: boolean;
  image_update: boolean;
  recovery: boolean;
  health: boolean;
}

export interface SpineRuntimeStatus {
  kind: 'mutable-host' | 'appliance-image';
  manifest_valid: boolean;
  repair_required: boolean;
  error_code?: string;
  image_version?: string;
  build_id?: string;
  source_tree?: string;
  architecture?: string;
  firmware_mode?: string;
  disk_layout_version?: number;
  recovery_version?: string;
  artifact_kind?: 'production' | 'stable' | 'beta' | 'development' | 'test';
  capabilities: SpineRuntimeCapabilities;
}

export interface SpinePersistentStatus {
  available: boolean;
  lifecycle?: 'unconfigured' | 'configured' | 'repair-required' | 'factory';
  state_schema_version?: number;
  data_schema_version?: number;
  disk_layout_version?: number;
  compatibility: { state: string; data: string; compatible: boolean; repair_required: boolean };
  slots: {
    current: string;
    current_image_version: string;
    previous?: string;
    previous_image_version?: string;
    candidate?: string;
    candidate_image_version?: string;
  };
  transaction_stage?: string;
  target_image_version?: string;
  recovery_version?: string;
  error_code?: string;
}

export interface SpineRemoteAccessKey {
  id: string;
  fingerprint: string;
  type: string;
  bits?: number;
  comment?: string;
  source: string;
  added_at: string;
}

export interface SpineRemoteAccessKeysResponse {
  schema: 'youeye.appliance.ssh-keys.v1';
  keys: SpineRemoteAccessKey[];
  root_password_locked: boolean;
}

export interface SpineConsoleAccount {
  user_id: string;
  /** Host login name; chosen once by Spine, never follows a YouEye ID rename. */
  username: string;
  admin: boolean;
  locked: boolean;
  has_password: boolean;
}

/** Console access: the admins' host accounts (never a hash). */
export interface SpineConsoleStatus {
  accounts: SpineConsoleAccount[];
  root_password_set: boolean;
  password_ssh: boolean;
  ssh_scope?: string;
  owner_reset_pending: boolean;
}

export interface SpineHostNetworkStatus {
  schema: 'youeye.host-network-status.v1';
  phase: 'starting' | 'checking' | 'ready' | 'needs_attention';
  adapter?: string;
  kind: 'ethernet';
  ipv4_mode: 'dhcp' | 'static';
  ipv4_address?: string;
  error_code?: string;
  detail?: string;
  updated_at?: string;
  wifi_supported: false;
  can_configure_locally: boolean;
}

export interface SpineStatusResponse {
  spine: {
    version: string;
  };
  incus: {
    version: string;
  };
  control_panel: {
    status: string;
    version?: string;
  };
  ui?: {
    status: string;
    installed: boolean;
    enabled: boolean;
    version?: string;
    ip?: string;
    sso_configured?: boolean;
  };
  host: {
    os: string;
  };
  runtime: SpineRuntimeStatus;
  persistent_state?: SpinePersistentStatus;
  runtime_warning?: string;
}

export interface SpineMetricsResponse {
  hostname: string;
  primary_ip: string;
  os: string;
  kernel: string;
  uptime: string;
  load_average?: string;
  cpu: {
    cores: number;
    model: string;
    usage_percent?: string;
  };
  memory: {
    total_mb: number;
    used_mb: number;
    free_mb: number;
  };
  disk: {
    total_gb: number;
    used_gb: number;
    free_gb: number;
  };
}

interface SpineUpdateStatus {
  attempt_id?: string;
  authority?: 'spine';
  component: string;
  status: string;
  progress: number;
  message: string;
  version_before?: string;
  version_after?: string;
  error?: string;
  started_at?: string;
  updated_at: string;
}

export interface CoreUpdateStatus {
  schema: 'youeye.core-status.v1';
  managed: boolean;
  /** The box's repository and channel from the host-owned release policy. */
  selection?: { repository: string; channel: string };
  installed?: {
    manifest_sha256: string;
    /** `version` is what the box shows; releases are ordered by line and `sequence`. */
    release: { version: string; tag: string; sequence: number; source_tree: string };
    members?: { role: string; source_tree: string; sha256: string }[];
    accepted_at: string;
    machine_bound: boolean;
    payload_observation: 'not-observed';
  };
  transaction?: { request_id: string; manifest_sha256: string; phase: string; restart_required: boolean; activation_requested: boolean; target_version: string; complete: boolean; steps: { name: string; state: string; action_state?: string; stage?: string; code?: string; effect_state?: string;
    /** Why the step failed, as one short line from Spine. Present only for a `failed` step, or for a `started` step
     * whose outcome is uncertain (phase `needs-recovery`) when its action recorded an error. */
    evidence?: string }[]; error?: string;
    /** Once recovery owns the request, `steps` is the recovery graph; this is the apply step that stopped the update
     * (`failed`, or `started` with an uncertain outcome) and its reason, if Spine has one. */
    stopped_step?: { name: string; state: string; evidence?: string } };
}

export interface CoreUpdateCandidate {
  release: { version: string; tag: string; sequence: number; source_tree?: string };
  manifest_sha256: string;
  restart_required: boolean;
  /** The channel head is older than the installed version; the box waits for it to catch up. */
  behind?: boolean;
  message?: string;
}
export interface CoreUpdateRequest { request_id: string; command_id: string; manifest_sha256: string }
export type CoreUpdateAction = 'stage' | 'activate' | 'resume' | 'recover' | 'cancel';
export interface CoreUpdateActionResult {
  request_id: string; manifest_sha256: string; phase: string;
  control: { request_id: string; command_id: string; state: string };
}

export interface SpineReleaseChannel {
  repository: string;
  channel: string;
  installed_version?: string;
  /** After a repository switch: the YouEye version the new channel offers. */
  head_version?: string;
}

export interface SpineReleaseIndex {
  repository: string;
  channel: string;
  index: unknown;
  index_sha256: string;
}

/** Console access calls run inside identity requests; never hold one for long. */
const CONSOLE_TIMEOUT_MS = 15_000;

export class SpineAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly response?: Record<string, unknown>,
    /** The answer's headers (Spine's rate limits put their reset time there). */
    public readonly headers?: Record<string, string | string[] | undefined>,
  ) {
    super(message);
    this.name = 'SpineAPIError';
  }
}

interface SpinePostgresCredentials {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

interface SpinePiholeCredentials {
  password: string;
}

/**
 * How long a System update action (stage, activate, resume, recover, cancel) waits for Spine's answer. Spine itself
 * waits up to 90 s for a gap in the pruning of finished updates before it stages or cancels
 * (spine/internal/api/core_update_actions.go, coreActionPruneWait); with the default 60 s the Control Panel gave up
 * first and showed an error for a request that Spine staged a moment later.
 */
export const CORE_UPDATE_ACTION_TIMEOUT_MS = 150_000;

/**
 * How long the start of a backup archive step (`/api/backup/run`) waits for Spine's answer. Spine waits up to 90 s
 * to admit the step when a System update or a Control Panel restart holds the admission gate at that moment
 * (spine/internal/systemupdate/core_lifecycle.go, OrdinaryAdmissionWait), so the wait here is that plus the default
 * 60 s for the start itself (the archive is then made in the background and polled).
 */
export const ARCHIVE_STEP_TIMEOUT_MS = 150_000;

/**
 * How long a backup or restore step waits in which Spine does the whole work before it answers: the archive
 * restore, the restore's volume, Incus prepare and import steps, and the drive store and import, whose time grows
 * with the data. Spine ends such a step itself after 6 hours (spine/internal/backup/step.go, StepCeiling) and
 * answers with an error, so this is that plus 15 minutes for its commands to stop and its cleanup: the Control
 * Panel, which holds the lifecycle lock and the backup operation lock meanwhile, always ends too, also when Spine
 * hangs. Spine stops the step's commands when the Control Panel hangs up.
 */
export const BACKUP_STEP_TIMEOUT_MS = 6 * 60 * 60_000 + 15 * 60_000;

export class SpineClient {
  private readonly socketPath: string;

  constructor(socketPath: string | undefined = process.env.SPINE_SOCKET) {
    this.socketPath = socketPath?.trim() || SPINE_SOCKET;
  }

  private async request<T>(
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    timeoutMs: number = 60000,
  ): Promise<T> {
    try {
      return await this.requestOnSocket<T>(this.socketPath, path, method, body, timeoutMs);
    } catch (error) {
      if (error instanceof SpineTransportError && UNREACHABLE_SOCKET_CODES.has(error.code || '')) {
        // The same message as ever, and still a transport error for a caller that asks (the backup's drive store).
        throw new SpineTransportError(
          `Control Panel could not reach the Spine API through its socket (${this.socketPath}): ${error.message}`,
          error.code,
          this.socketPath,
        );
      }
      throw error;
    }
  }

  private async requestOnSocket<T>(
    socketPath: string,
    path: string,
    method: string,
    body: Record<string, unknown> | undefined,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        socketPath,
        path: path,
        method: method,
        headers: {
          'Content-Type': 'application/json',
        },
      };

      const req = http.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new SpineAPIError(
                parsed.message || parsed.error || `Request failed with status ${res.statusCode}`,
                res.statusCode,
                parsed.code,
                parsed as Record<string, unknown>,
                res.headers,
              ));
            } else {
              resolve(parsed as T);
            }
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on('error', (err: NodeJS.ErrnoException) => {
        reject(new SpineTransportError(`Spine API transport error: ${err.message}`, err.code, socketPath));
      });

      // Set timeout — 60s for longer operations like UI SSO setup.
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy();
          reject(new SpineTransportError('Request timeout', 'ETIMEDOUT', socketPath));
        });
      }

      if (body) {
        req.write(JSON.stringify(body));
      }

      req.end();
    });
  }

  /**
   * Health check
   */
  async health(): Promise<{ status: string }> {
    return this.request('/api/health');
  }

  /**
   * Get Spine version
   */
  async version(): Promise<SpineVersionResponse> {
    return this.request('/api/version');
  }

  /**
   * Get system status
   */
  async status(): Promise<SpineStatusResponse> {
    return this.request('/api/status');
  }

  /**
   * Get host metrics
   */
  async getMetrics(): Promise<SpineMetricsResponse> {
    return this.request('/api/metrics');
  }

  /**
   * Verify PAM authentication
   */
  async verifyAuth(username: string, password: string): Promise<SpineAuthResponse> {
    return this.request('/api/auth/verify', 'POST', { username, password });
  }

  /**
   * Get current update status from Spine's status file
   */
  async getUpdateStatus(): Promise<SpineUpdateStatus> {
    return this.request('/api/update/status');
  }

  /** The box's release channel (host-owned policy; the repository never changes). */
  async getReleaseChannel(): Promise<SpineReleaseChannel> {
    return this.request('/api/releases/channel');
  }

  /**
   * Ask Spine to follow another channel and, with repository, another
   * repository (Spine reads its channel index first and may refuse).
   */
  async setReleaseChannel(channel: string, repository?: string): Promise<SpineReleaseChannel> {
    return this.request('/api/releases/channel', 'PUT', repository === undefined ? { channel } : { channel, repository });
  }

  /** The channel index of the box's channel, fetched and cached by Spine. */
  async getReleaseIndex(): Promise<SpineReleaseIndex> {
    return this.request('/api/releases/index');
  }

  async getRemoteAccessKeys(): Promise<SpineRemoteAccessKeysResponse> {
    return this.request('/api/appliance/remote-access/keys');
  }

  async consoleStatus(): Promise<SpineConsoleStatus> {
    return this.request('/api/console', 'GET', undefined, CONSOLE_TIMEOUT_MS);
  }

  /** Exactly these YouEye ID users are admins now; Spine locks every other account at once. */
  async syncConsoleAdmins(admins: Array<{ user_id: string; username: string }>): Promise<SpineConsoleStatus> {
    return this.request('/api/console/accounts/sync', 'POST', { admins }, CONSOLE_TIMEOUT_MS);
  }

  /** Sends an admin's console password once; Spine keeps only a yescrypt hash. */
  async setConsolePassword(userId: string, password: string): Promise<SpineConsoleStatus> {
    return this.request('/api/console/accounts/password', 'PUT', { user_id: userId, password }, CONSOLE_TIMEOUT_MS);
  }

  /** root_password: "" removes it. password_ssh: password SSH from the local subnet. */
  async updateConsoleSettings(settings: { root_password?: string; password_ssh?: boolean }): Promise<SpineConsoleStatus> {
    return this.request('/api/console/settings', 'PUT', { ...settings }, CONSOLE_TIMEOUT_MS);
  }

  /** Consumes the owner reset code shown on the box's console; a wrong, used or expired code is a 403. */
  async useOwnerResetCode(code: string): Promise<{ valid: true }> {
    return this.request('/api/console/owner-reset', 'POST', { code }, CONSOLE_TIMEOUT_MS);
  }

  async getHostNetworkStatus(): Promise<SpineHostNetworkStatus> {
    return this.request('/api/appliance/network');
  }

  async getCoreUpdateStatus(): Promise<CoreUpdateStatus> {
    return this.request('/api/appliance/core-update/status');
  }

  async checkCoreUpdate(): Promise<CoreUpdateCandidate> {
    return this.request('/api/appliance/core-update/check');
  }

  async submitCoreUpdate(action: CoreUpdateAction, request: CoreUpdateRequest): Promise<CoreUpdateActionResult> {
    return this.request(`/api/appliance/core-update/${action}`, 'POST', { ...request }, CORE_UPDATE_ACTION_TIMEOUT_MS);
  }

  async addRemoteAccessKey(publicKey: string): Promise<SpineRemoteAccessKey> {
    return this.request('/api/appliance/remote-access/keys', 'POST', { public_key: publicKey });
  }

  async deleteRemoteAccessKey(id: string, confirmLastKey: boolean): Promise<SpineRemoteAccessKey> {
    return this.request(`/api/appliance/remote-access/keys/${encodeURIComponent(id)}`, 'DELETE', {
      confirm_last_key: confirmLastKey,
    });
  }

  /**
   * Check if Spine is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.health();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get PostgreSQL connection credentials
   */
  async getPostgresCredentials(): Promise<SpinePostgresCredentials> {
    return this.request('/api/postgres/credentials');
  }

  /**
   * Get Pi-Hole web interface credentials
   */
  async getPiholeCredentials(): Promise<SpinePiholeCredentials> {
    return this.request('/api/pihole/credentials');
  }

  /**
   * Update Pi-Hole password stored on host
   */
  async updatePiholePassword(password: string): Promise<{ status: string }> {
    return this.request('/api/pihole/credentials', 'POST', { password });
  }

  /**
   * Get SSO configuration status from Spine
   */
  async getControlSSO(): Promise<{ configured: boolean; identity_url?: string; client_id?: string; identity_internal_url?: string }> {
    return this.request('/api/control/sso');
  }

  /**
   * Set SSO environment variables for Control Panel. They take effect at its next start: call restartControl.
   */
  async setControlSSO(params: {
    identity_url: string;
    client_id: string;
    client_secret: string;
    internal_url: string;
    identity_internal_url?: string;
    control_url: string;
  }): Promise<{ status: string; message: string }> {
    return this.request('/api/control/sso', 'POST', params);
  }

  /**
   * Get UI SSO configuration status
   */
  async getUISSO(): Promise<{
    configured: boolean;
    service_active: boolean;
    client_id?: string;
    domain?: string;
  }> {
    return this.request('/api/ui/sso');
  }

  /**
   * Configure UI SSO and start service
   */
  async setUISSO(params: {
    identity_url: string;
    identity_internal_url: string;
    client_id: string;
    client_secret: string;
    jwt_secret: string;
    database_url: string;
    domain: string;
    base_url: string;
  }): Promise<{ status: string; message: string }> {
    return this.request('/api/ui/sso', 'POST', params);
  }

  /**
   * Disable UI SSO and stop service
   */
  async deleteUISSO(): Promise<{ status: string; message: string }> {
    return this.request('/api/ui/sso', 'DELETE');
  }

  /**
   * Get site-level YouEye configuration from youeye.yaml
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getConfig(): Promise<Record<string, any>> {
    const raw = await this.request('/api/config') as Record<string, unknown>;
    // Spine stores unrecognized keys in an "extra" map. Merge them into
    // the top level so callers can read e.g. raw.tls_acme_account_key
    // without knowing about the extra indirection. Keep the original extra
    // object too so settingsService's typed cache can later reconstruct raw
    // extras instead of dropping provider/TLS metadata.
    if (raw.extra && typeof raw.extra === 'object') {
      const { extra, ...rest } = raw;
      return { ...rest, ...extra as Record<string, unknown>, extra };
    }
    return raw;
  }

  /**
   * Replace site-level YouEye configuration
   */
  async setConfig(config: { site_name?: string; domain?: string; subdomains?: Record<string, string>; setup_completed?: boolean }): Promise<{ status: string; config: { site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean } }> {
    return this.request('/api/config', 'PUT', config as Record<string, unknown>);
  }

  /**
   * Partially update site-level YouEye configuration
   */
  async patchConfig(patch: Record<string, unknown>): Promise<{ status: string; config: { site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean } }> {
    return this.request('/api/config', 'PATCH', patch);
  }

  /**
   * Schedule a Control Panel restart: after the delay (seconds), once no app or platform lifecycle work runs (Spine
   * waits for it, so an install started meanwhile finishes first). Answers at once with status 'scheduled'.
   */
  async restartControl(delaySeconds: number = 5): Promise<{ status: string; message: string }> {
    return this.request(`/api/control/restart?delay=${delaySeconds}`, 'POST');
  }

  /**
   * Whether a Control Panel restart waits, since when, and since when it is known to wait past its longest wait
   * under a platform backup or restore (lib/health/control-restart-held.ts).
   */
  async controlRestartStatus(): Promise<{ waiting?: boolean; waiting_since?: string; backup_held_since?: string }> {
    return this.request('/api/control/restart', 'GET');
  }

  /**
   * Start a backup operation on Spine.
   * Spine handles host-level operations: stop containers, copy volumes, archive, encrypt.
   */
  async startBackup(params: {
    target_path: string;
    passphrase?: string;
    use_stored_passphrase?: boolean;
    containers: string[];
    volume_mappings?: Array<{ source: string; archive_path: string }>;
    incus_runtimes?: Array<{ name: string; type: 'oci' | 'lxd' }>;
    incus_volumes?: Array<{ pool: string; name: string }>;
    staging_dir: string;
    hostname: string;
    backup_type: 'core' | 'app';
    app_id?: string;
  }): Promise<{ status: string; backup_id: string }> {
    return this.request('/api/backup/run', 'POST', params, ARCHIVE_STEP_TIMEOUT_MS);
  }

  /**
   * Get current backup status from Spine's status file.
   */
  async getBackupStatus(): Promise<SpineBackupStatus> {
    return this.request('/api/backup/status');
  }

  /**
   * Get the storage driver used by Incus (dir, zfs, btrfs, etc.)
   */
  async getStorageDriver(): Promise<{ driver: string }> {
    return this.request('/api/backup/storage-driver');
  }

  /**
   * Decrypt and extract a backup archive to a staging directory.
   * Used during restore operations.
   *
   * Spine verifies, decrypts and extracts before it answers, so the wait is the long one (BACKUP_STEP_TIMEOUT_MS):
   * a large archive takes its time. Spine stops when the caller hangs up, so a wait that ends here never leaves
   * Spine writing the staging directory. A Spine that stops closes the socket, which ends the wait.
   */
  async restoreArchive(params: {
    archive_path: string;
    passphrase: string;
    staging_dir: string;
    /** The set's recorded encryption; left out for a set made before it was recorded. */
    encryption?: BackupEncryption;
  }): Promise<{ staging_dir: string; message: string }> {
    return this.request('/api/backup/restore', 'POST', params, BACKUP_STEP_TIMEOUT_MS);
  }

  async applyBackupVolumes(stagingDir: string): Promise<{ status: string; restored: number }> {
    return this.request('/api/backup/apply-volumes', 'POST', { staging_dir: stagingDir }, BACKUP_STEP_TIMEOUT_MS);
  }

  async prepareIncusRecovery(
    stagingDir: string,
    poolMap: Record<string, string> = {},
  ): Promise<{
    status: 'prepared' | 'not-present';
    runtimes: Array<{ name: string; type: 'oci' | 'lxd'; fingerprint?: string; archive_path?: string }>;
    volumes: Array<{ pool: string; name: string; created?: boolean }>;
  }> {
    const response = await this.request<{
      status: 'prepared' | 'not-present';
      runtimes: Array<{ name: string; type: 'oci' | 'lxd'; fingerprint?: string; archive_path?: string }> | null;
      volumes: Array<{ pool: string; name: string; created?: boolean }> | null;
    }>('/api/backup/incus/prepare', 'POST', {
      staging_dir: stagingDir,
      pool_map: poolMap,
    }, BACKUP_STEP_TIMEOUT_MS);
    return {
      ...response,
      runtimes: Array.isArray(response.runtimes) ? response.runtimes : [],
      volumes: Array.isArray(response.volumes) ? response.volumes : [],
    };
  }

  async importIncusInstance(params: {
    archivePath: string;
    name: string;
    pool: string;
    network?: string;
    offline?: boolean;
  }): Promise<{ status: string; name: string }> {
    return this.request('/api/backup/incus/import-instance', 'POST', {
      archive_path: params.archivePath,
      name: params.name,
      pool: params.pool,
      network: params.network,
      ...(params.offline ? { offline: true } : {}),
    }, BACKUP_STEP_TIMEOUT_MS);
  }

  /**
   * Get backup schedule configuration.
   */
  async getBackupConfig(): Promise<import('@/lib/backup/types').BackupScheduleConfig> {
    return this.request('/api/backup/config');
  }

  /**
   * Set backup schedule configuration.
   */
  async setBackupConfig(config: import('@/lib/backup/types').BackupScheduleConfig): Promise<{ status: string }> {
    return this.request('/api/backup/config', 'POST', config as unknown as Record<string, unknown>);
  }

  async getBackupMedia(): Promise<{ media: import('@/lib/backup/types').BackupMedia[] }> {
    return this.request('/api/backup/media');
  }

  async prepareBackupMedia(mediaId: string): Promise<import('@/lib/backup/types').BackupMedia> {
    return this.request('/api/backup/media/prepare', 'POST', {
      media_id: mediaId,
      confirmation: `ERASE ${mediaId}`,
    });
  }

  async ejectBackupMedia(mediaId: string): Promise<{ status: string }> {
    return this.request('/api/backup/media/eject', 'POST', { media_id: mediaId });
  }

  async storeBackupRecoveryKey(passphrase: string): Promise<{ status: string }> {
    return this.request('/api/backup/recovery-key', 'POST', { passphrase });
  }

  async storeBackupSet(params: {
    media_id: string;
    backup_id: string;
    passphrase?: string;
    use_stored_passphrase?: boolean;
    apps: string[];
    created_at: string;
    size_bytes: number;
    reason: 'manual' | 'scheduled' | 'pre-restore';
    source: BackupSourceIdentity;
  }): Promise<{ status: string; backup_id: string }> {
    return this.request('/api/backup/repository/store', 'POST', params, BACKUP_STEP_TIMEOUT_MS);
  }

  async importBackupSet(params: {
    media_id: string;
    backup_id: string;
    passphrase?: string;
    use_stored_passphrase?: boolean;
  }): Promise<{ status: string; backup_path: string }> {
    return this.request('/api/backup/repository/import', 'POST', params, BACKUP_STEP_TIMEOUT_MS);
  }

  async getExternalRecoveryPoints(mediaId: string): Promise<{ recovery_points: import('@/lib/backup/types').ExternalRecoveryPoint[] }> {
    const catalog = await this.request<{ recovery_points: import('@/lib/backup/types').ExternalRecoveryPoint[] | null }>(`/api/backup/repository/catalog?media_id=${encodeURIComponent(mediaId)}`);
    // A recovery point without apps may list them as null (written by an older Spine).
    return { recovery_points: (catalog.recovery_points ?? []).map(point => ({ ...point, apps: point.apps ?? [] })) };
  }
}

// Export singleton instance
export const spineClient = new SpineClient();
