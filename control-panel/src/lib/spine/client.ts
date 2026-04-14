/**
 * Spine API Client
 * 
 * Communicates with Spine via Unix socket for:
 * - PAM authentication
 * - System status
 * - Updates
 */

import http from 'http';

interface SpineAuthResponse {
  authenticated: boolean;
  username: string;
  groups: string[];
}

interface SpineVersionResponse {
  version: string;
  service: string;
}

interface SpineStatusResponse {
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

interface SpineUpdatesCheckResponse {
  checked_at: string;
  spine: {
    current: string;
    latest: string;
    available: boolean;
  };
  control: {
    current: string;
    latest: string;
    available: boolean;
  };
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

interface SpineAuthentikCredentials {
  db_password: string;
  secret_key: string;
  bootstrap_token: string;
  bootstrap_password: string;
  internal_url: string;
}

export class SpineClient {
  private socketPath: string;

  constructor(socketPath: string = '/var/run/spine/spine.sock') {
    this.socketPath = socketPath;
  }

  private async request<T>(
    path: string,
    method: string = 'GET',
    body?: Record<string, unknown>
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        socketPath: this.socketPath,
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
              reject(new Error(parsed.error || `Request failed with status ${res.statusCode}`));
            } else {
              resolve(parsed as T);
            }
          } catch {
            reject(new Error(`Failed to parse response: ${data}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Spine API error: ${err.message}`));
      });

      // Set timeout — 60s for longer operations like UI SSO setup
      req.setTimeout(60000, () => {
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
   * Verify PAM authentication
   */
  async verifyAuth(username: string, password: string): Promise<SpineAuthResponse> {
    return this.request('/api/auth/verify', 'POST', { username, password });
  }

  /**
   * Update Spine
   */
  async updateSelf(): Promise<SpineUpdateResponse> {
    return this.request('/api/update/self', 'POST');
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
  async updateControl(): Promise<SpineUpdateResponse> {
    return this.request('/api/update/control', 'POST');
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
   * Get Authentik credentials (DB password, secret key, bootstrap token, internal URL)
   */
  async getAuthentikCredentials(): Promise<SpineAuthentikCredentials> {
    return this.request('/api/authentik/credentials');
  }

  /**
   * Get SSO configuration status from Spine
   */
  async getControlSSO(): Promise<{ configured: boolean; authentik_url?: string; authentik_client_id?: string; authentik_internal_url?: string }> {
    return this.request('/api/control/sso');
  }

  /**
   * Set SSO environment variables for Control Panel (triggers restart)
   */
  async setControlSSO(params: { authentik_url: string; client_id: string; client_secret: string; internal_url: string; control_url: string }): Promise<{ status: string; message: string }> {
    return this.request('/api/control/sso', 'POST', params);
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
    authentik_url: string;
    authentik_internal_url: string;
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
  async getConfig(): Promise<{ site_name: string; domain: string; subdomains: Record<string, string>; setup_completed: boolean; release_branch?: string; language?: string }> {
    return this.request('/api/config');
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
    passphrase: string;
    containers: string[];
    volume_paths: string[];
    staging_dir: string;
    hostname: string;
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
  }): Promise<{ status: string }> {
    return this.request('/api/backup/restore', 'POST', params);
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

  /**
   * Get the backup index (list of available backups).
   * Optionally filter by type (core/app) and appId.
   */
  async getBackupList(type?: string, appId?: string): Promise<import('@/lib/backup/types').BackupIndex> {
    const params = new URLSearchParams();
    if (type) params.set('type', type);
    if (appId) params.set('app_id', appId);
    const query = params.toString();
    return this.request(`/api/backup/list${query ? `?${query}` : ''}`);
  }

  /**
   * Prune old backups based on retention policy.
   */
  async pruneBackups(type: string, appId: string, retention: number): Promise<{ deleted: number }> {
    return this.request('/api/backup/prune', 'POST', { type, app_id: appId, retention });
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
