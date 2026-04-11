/**
 * Backup system types.
 *
 * Defines the backup configuration, manifest backup schema,
 * and event types for SSE progress streaming.
 */

/** Backup configuration passed to the backup engine */
export interface BackupConfig {
  /** Target directory path on the host for the final archive */
  targetPath: string;
  /** AES-256 encryption passphrase */
  passphrase: string;
  /** Hostname for the backup filename */
  hostname: string;
}

/** Event emitted during backup progress (sent via SSE) */
export interface BackupEvent {
  step: number;
  totalSteps: number;
  status: 'progress' | 'completed' | 'error';
  stage: string;
  message: string;
  detail?: string;
  progress?: number;
  archivePath?: string;
  archiveSize?: number;
}

/** Callback for backup progress events */
export type BackupEventCallback = (event: BackupEvent) => void;

/** Manifest backup declaration (from app manifest YAML) */
export interface ManifestBackupSection {
  strategy?: 'stop-dump-export' | 'live-export' | 'snapshot';
  stopOrder?: string[];
  startOrder?: string[];
  ownPostgres?: {
    container: string;
    database: string;
  };
  volumes?: string[];
  exclude?: string[];
}

/** Info about a single app's backup requirements */
export interface AppBackupPlan {
  appId: string;
  appName: string;
  containerNames: string[];
  stopOrder: string[];
  startOrder: string[];
  useSharedPostgres: boolean;
  sharedDbName?: string;
  ownPostgres?: {
    container: string;
    database: string;
  };
  volumePaths: string[];
  excludePaths: string[];
}

/** Status returned from Spine's backup status endpoint */
export interface SpineBackupStatus {
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
