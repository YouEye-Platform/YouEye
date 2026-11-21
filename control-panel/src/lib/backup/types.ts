/**
 * Backup system types.
 *
 * Defines the backup configuration, manifest backup schema,
 * and event types for SSE progress streaming.
 */

import type { IdentityClient } from '@/lib/identity/store';

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

/**
 * How Spine encrypted a backup's archives (OpenSSL `enc`, PBKDF2 key). Spine reports it with each finished archive;
 * the set records it in backup-set.json, and a restore sends it back. A set without it was made before it was
 * recorded (YouEye up to 0.6.14), and Spine then uses the parameters of that time.
 */
export interface BackupEncryption {
  cipher: string;
  kdf: string;
  digest: string;
  iterations: number;
  /** How the key of each archive's .hmac file is made: `hmac-sha256-pbkdf2` (PBKDF2 with the digest and iterations
   * above, salted with a label and the archive's own salt). Absent in sets made before it: the raw passphrase. */
  mac?: string;
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
  /** On a completed backup: how its archive is encrypted. */
  encryption?: BackupEncryption;
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
  /** The archive's recorded encryption (its set's backup-set.json, or the rollback backup's own). */
  encryption?: BackupEncryption;
}

/** Full platform restore configuration */
export interface SetupRestoreCheckpoint {
  /** Only a completed durable step may be skipped. */
  completed(step: string): boolean;
  /** "replace" requires an idempotent assignment/readback; never use it for an unknown native import or SQL execution. */
  step(name: string, retry: 'replace' | 'never', work: () => Promise<void>): Promise<void>;
  rememberQuiesced(names: string[]): Promise<void>;
  quiesced(): string[];
}

/** What a server restore has done so far; the caller of a failed one reads it to put the box back. */
export interface FullRestoreProgress {
  /** False until the restore changes the box: a restore refused before that has nothing to roll back. */
  changed: boolean;
  /** The core services the restore stopped. After a failure some of them can still be stopped. */
  stoppedServices: string[];
  /** The YouEye ID clients of the kept apps as the restore found them, before it replaced the databases. */
  keptAppClients?: IdentityClient[];
}

export interface FullRestoreConfig {
  backupPath: string;  // root of backup dir (contains youeye/)
  passphrase: string;
  coreArchivePath?: string;
  /**
   * The application archives to restore; the core is always restored. On a box in use, every other installed app
   * stays installed (its data is not in the core archive) and is never removed. During setup the box has none.
   */
  appIds: string[];
  /**
   * Installed apps to remove without restoring them. Only the rollback of a failed restore uses it, for the apps
   * that restore added and the box did not have before.
   */
  discardAppIds?: string[];
  /** Core services an earlier failed restore stopped and did not start again: this restore starts them. */
  stoppedServices?: string[];
  /**
   * The YouEye ID clients of the kept apps as an earlier failed restore found them. Its rollback puts these back
   * instead of reading clients that the failed restore may already have replaced with its backup's.
   */
  keptAppClients?: IdentityClient[];
  /** Filled in while the restore runs (see FullRestoreProgress). */
  progress?: FullRestoreProgress;
  /**
   * Run only the checks that can refuse the restore (the archive opens, it is compatible, every installed app can
   * be kept or is selected) and change nothing. The restore route asks this before it makes the pre-restore backup.
   */
  checkOnly?: boolean;
  /** Keep setup incomplete until the setup route has finished every restore gate. */
  setupMode?: boolean;
  /** Setup-only durable checkpoints, held under the setup and backup lifecycle locks. */
  setupRecovery?: SetupRestoreCheckpoint;
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
  source_tree?: string;
  state_schema_version?: number;
  data_schema_version?: number;
  disk_layout_version?: number;
  spine_version: string;
  /**
   * Old shape (0.6.11): the build names of the Control Panel, UI and Pointer.
   * Written alongside the release keys below until the Release cleanup (an
   * older Control Panel orders backups by them); never shown.
   */
  control_panel_version?: string;
  ui_version?: string;
  pointer_version?: string;
  /** The installed YouEye release (from 0.6.12): what a backup shows, and its order. */
  release?: BackupRelease;
  /** The release that installed the Control Panel and UI, with each part's own git tree. */
  control_panel?: BackupRelease;
  ui?: BackupRelease;
  /** Pointer's installed product release. */
  pointer?: BackupRelease;
}

/** A release in a backup's identity: its version (display), order key (line, sequence) and git tree. */
export interface BackupRelease {
  version: string;
  line: string;
  sequence: number;
  source_tree: string;
}
