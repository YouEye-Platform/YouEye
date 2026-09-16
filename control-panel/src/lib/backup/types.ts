/**
 * Backup system types.
 *
 * Defines the backup configuration, manifest backup schema,
 * and event types for SSE progress streaming.
 */

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
  ownPostgres?: {
    container: string;
    database: string;
    user?: string;
  };
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

// ─── Phase C: Per-app & core backup/restore types ────────

/** Per-app backup configuration */
export interface AppBackupConfig {
  appId: string;
  targetPath: string;
  passphrase?: string;
  useStoredPassphrase?: boolean;
  sourceIdentity?: BackupSourceIdentity;
}

/** Core platform backup configuration */
export interface CoreBackupConfig {
  targetPath: string;
  passphrase?: string;
  useStoredPassphrase?: boolean;
  hostname?: string;
  sourceIdentity?: BackupSourceIdentity;
}

/** Restore configuration for a single app */
export interface AppRestoreConfig {
  appId: string;
  archivePath: string;
  passphrase: string;
}

/** Full platform restore configuration */
export interface FullRestoreConfig {
  backupPath: string;  // root of backup dir (contains youeye/)
  passphrase: string;
  coreArchivePath?: string;
  /** Restore only these application archives; core is always restored. */
  appIds?: string[];
  /** Keep setup incomplete until the setup route has finished every restore gate. */
  setupMode?: boolean;
}

/** Backup schedule configuration */
export interface BackupScheduleConfig {
  enabled: boolean;
  targetPath: string;
  mediaId?: string;
  selectedApps?: string[];
  recoveryKeyStored?: boolean;
  lastError?: string;
  schedule: {
    core: {
      frequency: 'daily' | 'weekly' | 'monthly';
      retention: number;
      time: string;  // HH:MM format
	  last_run?: string;
    };
    defaultApp: {
      frequency: 'daily' | 'weekly' | 'monthly' | 'never';
      retention: number;
	  last_run?: string;
    };
    overrides: Record<string, {
      frequency: 'daily' | 'weekly' | 'monthly' | 'never';
      retention: number;
	  last_run?: string;
    }>;
  };
}

export interface BackupMedia {
  id: string;
  device: string;
  model?: string;
  size_bytes: number;
  state: 'blank' | 'available' | 'ready' | 'unsupported';
  filesystem?: string;
  mountpoint?: string;
  reason?: string;
  backup_ids?: string[];
}

export interface ExternalRecoveryPoint {
  backup_id: string;
  created_at: string;
  apps: string[];
  size_bytes?: number;
  reason?: 'manual' | 'scheduled' | 'pre-restore';
  verified_at?: string;
  source?: BackupSourceIdentity;
}

/** Portable source identity recorded in every recovery point. */
export interface BackupSourceIdentity {
  schema: 'youeye.backup.source.v1';
  runtime_kind: 'mutable-host' | 'appliance-image';
  image_version?: string;
  source_commit?: string;
  release_branch?: string;
  state_schema_version?: number;
  data_schema_version?: number;
  disk_layout_version?: number;
  spine_version: string;
  control_panel_version?: string;
  ui_version?: string;
}
