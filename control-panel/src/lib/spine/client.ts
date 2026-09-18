/**
 * Spine API Client
 * 
 * Communicates with Spine via Unix socket for:
 * - PAM authentication
 * - System status
 * - Updates
 */

import http from 'http';
import type { BackupSourceIdentity } from '@/lib/backup/types';

const CANONICAL_SPINE_SOCKET = '/var/run/youeye/youeye.sock';
const LEGACY_SPINE_SOCKET = '/var/run/spine/spine.sock';
const FALLBACK_TRANSPORT_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK']);

class SpineTransportError extends Error {
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
  version: string;
  service: string;
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
  source_commit?: string;
  architecture?: string;
  firmware_mode?: string;
  disk_layout_version?: number;
  recovery_version?: string;
  artifact_kind?: 'production' | 'stable' | 'beta' | 'development' | 'test';
  release_source?: string;
  release_branch?: string;
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

export interface SpineDevelopmentAccessStatus {
  schema: 'youeye.development-access-status.v2';
  local_root_console_requested: boolean;
  local_root_console_persisted: boolean;
  local_root_console_active: boolean;
  local_root_console_effective: boolean;
  root_password_ssh_requested: boolean;
  root_password_ssh_effective: boolean;
  network_scope?: string;
  detail: string;
  can_enable_remotely: false;
  can_disable_remotely: boolean;
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

interface SpineUpdateResponse {
  status: string;
  message: string;
  output?: string;
  reboot_required?: boolean;
  old_version?: string;
  new_version?: string;
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

export interface ApplianceSystemUpdateStatus {
  schema: 'youeye.system-update.v1';
  state: 'healthy' | 'available' | 'downloading' | 'writing' | 'staged' | 'pending-reboot' | 'trial' | 'failed' | 'rolled-back';
  current_image: string;
  running_image: string;
  target_image?: string;
  active_slot: string;
  candidate_slot?: string;
  previous_slot?: string;
  transaction_id?: string;
  manifest_sha256?: string;
  downloaded_bytes?: Record<string, number>;
  trial_failures?: number;
  boot_attempts?: number;
  reboot_required: boolean;
  rolled_back: boolean;
  error_code?: string;
  error?: string;
  channel?: string;
  release_tag?: string;
  release_notes?: string;
  required_cache_bytes?: number;
  available_cache_bytes?: number;
  updated_at?: string;
}

export interface ApplianceSystemUpdateSelection {
  provider: 'github' | 'forgejo' | 'custom';
  releases_api?: string;
  channel: 'stable' | 'development' | 'branch' | 'exact';
  branch?: string;
  exact_tag?: string;
  manifest_sha256?: string;
  replace_failed?: boolean;
}

/** Channel-aware per-component fields Spine adds to /api/updates/check. */
export interface SpineComponentChannel {
  source?: string;
  branch?: string;
  fallback?: string[];
}
export interface SpineComponentVersionRef {
  version?: string;
  branch?: string;
  tag?: string;
}
export interface SpineComponentUpdate {
  current: string;
  latest: string;
  available: boolean;
  // Channel-aware additions (present on updated Spine; optional for back-compat):
  channel?: SpineComponentChannel;
  installed?: SpineComponentVersionRef;
  candidate?: SpineComponentVersionRef;
  update_available?: boolean;
  switch_pending?: boolean;
  current_display?: string;
  latest_display?: string;
  supported?: boolean;
  managed_by?: 'package-manager' | 'system-image';
}

interface SpineUpdatesCheckResponse {
  checked_at: string;
  runtime: SpineRuntimeStatus;
  spine: SpineComponentUpdate;
  control: SpineComponentUpdate;
  incus?: {
    current: string;
    upgradeable: boolean;
  };
  system?: {
    upgradeable_count: number;
  };
  apps?: Array<{
    name: string;
    display_name: string;
    container_name: string;
    status: string;
    image_tag: string;
    available: boolean;
  }>;
}

export class SpineAPIError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly response?: Record<string, unknown>,
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

export class SpineClient {
  private readonly socketPaths: readonly string[];

  constructor(
    socketPath: string | undefined = process.env.SPINE_SOCKET,
    compatibilityPaths: { canonical: string; legacy: string } = {
      canonical: CANONICAL_SPINE_SOCKET,
      legacy: LEGACY_SPINE_SOCKET,
    },
  ) {
    const explicit = socketPath?.trim();
    this.socketPaths = explicit
      ? [explicit]
      : [compatibilityPaths.canonical, compatibilityPaths.legacy];
  }

  private async request<T>(
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>,
    timeoutMs: number = 60000,
  ): Promise<T> {
    let lastTransportError: SpineTransportError | undefined;
    for (const socketPath of this.socketPaths) {
      try {
        return await this.requestOnSocket<T>(socketPath, path, method, body, timeoutMs);
      } catch (error) {
        if (!(error instanceof SpineTransportError) || !FALLBACK_TRANSPORT_CODES.has(error.code || '')) {
          throw error;
        }
        lastTransportError = error;
      }
    }

    const attempted = this.socketPaths.join(', ');
    throw new Error(`Control Panel could not reach the Spine API through its configured socket paths (${attempted}): ${lastTransportError?.message || 'transport unavailable'}`);
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

      // Set timeout — 60s for longer operations like UI SSO setup
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

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
   * Update Spine
   */
  async updateSelf(opts?: { confirmSwitch?: boolean }): Promise<SpineUpdateResponse> {
    return this.request('/api/update/self', 'POST', opts?.confirmSwitch ? { confirm_switch: true } : undefined);
  }

  /**
   * Update Incus
   */
  async updateIncus(): Promise<SpineUpdateResponse> {
    return this.request('/api/update/incus', 'POST');
  }

  /**
   * Update host system
   */
  async updateSystem(): Promise<SpineUpdateResponse> {
    return this.request('/api/update/system', 'POST');
  }

  /**
   * Update Control Panel
   */
  async updateControl(opts?: { confirmSwitch?: boolean }): Promise<SpineUpdateResponse> {
    return this.request('/api/update/control', 'POST', opts?.confirmSwitch ? { confirm_switch: true } : undefined);
  }

  /**
   * Check for available updates
   */
  async checkUpdates(): Promise<SpineUpdatesCheckResponse> {
    return this.request('/api/updates/check');
  }

  /**
   * Get current update status from Spine's status file
   */
  async getUpdateStatus(): Promise<SpineUpdateStatus> {
    return this.request('/api/update/status');
  }

  async getRemoteAccessKeys(): Promise<SpineRemoteAccessKeysResponse> {
    return this.request('/api/appliance/remote-access/keys');
  }

  async getDevelopmentAccessStatus(): Promise<SpineDevelopmentAccessStatus> {
    return this.request('/api/appliance/development-access');
  }

  async disableDevelopmentAccess(): Promise<SpineDevelopmentAccessStatus> {
    return this.request('/api/appliance/development-access', 'DELETE');
  }

  async getHostNetworkStatus(): Promise<SpineHostNetworkStatus> {
    return this.request('/api/appliance/network');
  }

  async getApplianceSystemUpdateStatus(): Promise<ApplianceSystemUpdateStatus> {
    return this.request('/api/appliance/system-update/status');
  }

  async checkApplianceSystemUpdate(selection: ApplianceSystemUpdateSelection): Promise<ApplianceSystemUpdateStatus> {
    return this.requestApplianceSystemUpdateSource('/api/appliance/system-update/check', selection);
  }

  async stageApplianceSystemUpdate(selection: ApplianceSystemUpdateSelection): Promise<ApplianceSystemUpdateStatus> {
    return this.requestApplianceSystemUpdateSource('/api/appliance/system-update/stage', selection, 6 * 60 * 60 * 1000);
  }

  private async requestApplianceSystemUpdateSource(
    path: string,
    selection: ApplianceSystemUpdateSelection,
    timeoutMs: number = 60000,
  ): Promise<ApplianceSystemUpdateStatus> {
    try {
      return await this.request(
        path,
        'POST',
        selection as unknown as Record<string, unknown>,
        timeoutMs,
      );
    } catch (error) {
      // The immediately preceding Spine API accepts exact tag + digest requests,
      // but rejects the newer provider fields as unknown JSON. Only exact mode is
      // safe to bridge: the required manifest digest keeps the artifact identity
      // immutable even when that Spine uses its sealed-in release endpoint.
      if (
        error instanceof SpineAPIError
        && error.statusCode === 400
        && error.message === 'a valid manifest request is required'
        && selection.channel === 'exact'
        && typeof selection.exact_tag === 'string'
        && typeof selection.manifest_sha256 === 'string'
      ) {
        return this.request(path, 'POST', {
          channel: 'exact',
          exact_tag: selection.exact_tag,
          manifest_sha256: selection.manifest_sha256,
          ...(selection.replace_failed === true ? { replace_failed: true } : {}),
        }, timeoutMs);
      }
      throw error;
    }
  }

  async activateApplianceSystemUpdate(reboot: boolean): Promise<ApplianceSystemUpdateStatus> {
    return this.request('/api/appliance/system-update/activate', 'POST', { reboot });
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
   * Update an OCI app container (rebuild with latest image)
   */
  async updateApp(appName: string): Promise<SpineUpdateResponse> {
    return this.request(`/api/update/app/${appName}`, 'POST');
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
   * Set SSO environment variables for Control Panel (triggers restart)
   */
  async setControlSSO(params: {
    identity_url: string;
    client_id: string;
    client_secret: string;
    internal_url: string;
    identity_internal_url?: string;
    control_url: string;
  }, restartControl: boolean = true): Promise<{ status: string; message: string }> {
    return this.request(`/api/control/sso?restart=${restartControl}`, 'POST', params);
  }

  /**
   * Remove SSO configuration (triggers restart)
   */
  async deleteControlSSO(): Promise<{ status: string; message: string }> {
    return this.request('/api/control/sso', 'DELETE');
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
  async setConfig(config: { site_name?: string; domain?: string; subdomains?: Record<string, string>; setup_completed?: boolean; release_branch?: string }): Promise<{ status: string; config: { site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean; release_branch?: string } }> {
    return this.request('/api/config', 'PUT', config as Record<string, unknown>);
  }

  /**
   * Partially update site-level YouEye configuration
   */
  async patchConfig(patch: Record<string, unknown>): Promise<{ status: string; config: { site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean; release_branch?: string } }> {
    return this.request('/api/config', 'PATCH', patch);
  }

  /**
   * Schedule a Control Panel restart after a delay (seconds).
   * Used by reconfigure to restart CP after all changes are applied.
   */
  async restartControl(delaySeconds: number = 5): Promise<{ status: string; message: string }> {
    return this.request(`/api/control/restart?delay=${delaySeconds}`, 'POST');
  }

  /**
   * Fetch OCI image manifest digest from a remote registry.
   * Spine runs on the host with internet access; the CP container is firewalled.
   */
  async getRegistryDigest(image: string, tag: string = 'latest'): Promise<{ digest: string; image: string; tag: string }> {
    return this.request(`/api/registry/digest?image=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`);
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
    return this.request('/api/backup/run', 'POST', params);
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
   */
  async restoreArchive(params: {
    archive_path: string;
    passphrase: string;
    staging_dir: string;
  }): Promise<{ staging_dir: string; message: string }> {
    return this.request('/api/backup/restore', 'POST', params);
  }

  async applyBackupVolumes(stagingDir: string): Promise<{ status: string; restored: number }> {
    return this.request('/api/backup/apply-volumes', 'POST', { staging_dir: stagingDir });
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
    });
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
    network: string;
  }): Promise<{ status: string; name: string }> {
    return this.request('/api/backup/incus/import-instance', 'POST', {
      archive_path: params.archivePath,
      name: params.name,
      pool: params.pool,
      network: params.network,
    });
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
    return this.request('/api/backup/repository/store', 'POST', params);
  }

  async importBackupSet(params: {
    media_id: string;
    backup_id: string;
    passphrase?: string;
    use_stored_passphrase?: boolean;
  }): Promise<{ status: string; backup_path: string }> {
    return this.request('/api/backup/repository/import', 'POST', params);
  }

  async getExternalRecoveryPoints(mediaId: string): Promise<{ recovery_points: import('@/lib/backup/types').ExternalRecoveryPoint[] }> {
    return this.request(`/api/backup/repository/catalog?media_id=${encodeURIComponent(mediaId)}`);
  }
}

interface SpineBackupStatus {
  backup_id: string;
  status: string;
  progress: number;
  message: string;
  stage?: string;
  stages?: string[];
  current_step: number;
  total_steps: number;
  archive_path?: string;
  archive_size?: number;
  error?: string;
  started_at?: string;
  updated_at: string;
}

// Export singleton instance
export const spineClient = new SpineClient();
