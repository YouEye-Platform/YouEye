import { spineClient } from '@/lib/spine/client';
import type { BackupSourceIdentity } from './types';

export type { BackupSourceIdentity } from './types';

export interface BackupCompatibilityResult {
  compatible: boolean;
  summary: string;
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 256) throw new Error(`Backup ${field} is invalid.`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`Backup ${field} is invalid.`);
  return Number(value);
}

export function parseBackupSourceIdentity(value: unknown): BackupSourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Recovery point is missing its YouEye compatibility identity.');
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.schema !== 'youeye.backup.source.v1') {
    throw new Error('Recovery point uses an unsupported YouEye compatibility identity.');
  }
  if (candidate.runtime_kind !== 'mutable-host' && candidate.runtime_kind !== 'appliance-image') {
    throw new Error('Backup runtime kind is invalid.');
  }
  if (typeof candidate.spine_version !== 'string' || candidate.spine_version.length < 1 || candidate.spine_version.length > 128) {
    throw new Error('Backup System core version is invalid.');
  }
  const parsed: BackupSourceIdentity = {
    schema: 'youeye.backup.source.v1',
    runtime_kind: candidate.runtime_kind,
    image_version: optionalText(candidate.image_version, 'System version'),
    source_commit: optionalText(candidate.source_commit, 'source identity'),
    release_branch: optionalText(candidate.release_branch, 'release channel'),
    state_schema_version: optionalPositiveInteger(candidate.state_schema_version, 'State schema'),
    data_schema_version: optionalPositiveInteger(candidate.data_schema_version, 'Data schema'),
    disk_layout_version: optionalPositiveInteger(candidate.disk_layout_version, 'disk layout'),
    spine_version: candidate.spine_version,
    control_panel_version: optionalText(candidate.control_panel_version, 'Server interface version'),
    ui_version: optionalText(candidate.ui_version, 'UI version'),
  };
  if (parsed.runtime_kind === 'appliance-image'
    && (!parsed.image_version || !parsed.source_commit || !parsed.state_schema_version || !parsed.data_schema_version)) {
    throw new Error('Recovery point has an incomplete appliance compatibility identity.');
  }
  if (parsed.source_commit && !/^[0-9a-f]{40}$/.test(parsed.source_commit)) {
    throw new Error('Backup source identity is invalid.');
  }
  return parsed;
}

export async function readCurrentBackupSourceIdentity(): Promise<BackupSourceIdentity> {
  const status = await spineClient.status();
  if (status.runtime.kind === 'appliance-image') {
    if (!status.runtime.manifest_valid || status.runtime.repair_required
      || !status.persistent_state?.compatibility.compatible
      || status.persistent_state.compatibility.repair_required) {
      throw new Error('YouEye System compatibility must be healthy before creating or restoring a recovery point.');
    }
  }
  return parseBackupSourceIdentity({
    schema: 'youeye.backup.source.v1',
    runtime_kind: status.runtime.kind,
    image_version: status.runtime.image_version,
    source_commit: status.runtime.source_commit,
    release_branch: status.runtime.release_branch,
    state_schema_version: status.persistent_state?.state_schema_version,
    data_schema_version: status.persistent_state?.data_schema_version,
    disk_layout_version: status.persistent_state?.disk_layout_version ?? status.runtime.disk_layout_version,
    spine_version: status.spine.version,
    control_panel_version: status.control_panel.version,
    ui_version: status.ui?.version,
  });
}

export function assessBackupCompatibility(
  sourceInput: unknown,
  currentInput: unknown,
): BackupCompatibilityResult {
  const source = parseBackupSourceIdentity(sourceInput);
  const current = parseBackupSourceIdentity(currentInput);
  if (source.runtime_kind !== current.runtime_kind) {
    return { compatible: false, summary: 'This recovery point was created by a different YouEye runtime type.' };
  }
  if (source.runtime_kind === 'appliance-image') {
    if ((source.state_schema_version ?? 0) > (current.state_schema_version ?? 0)
      || (source.data_schema_version ?? 0) > (current.data_schema_version ?? 0)) {
      return { compatible: false, summary: 'This recovery point was created by a newer YouEye System. Update this server before restoring it.' };
    }
  }
  return {
    compatible: true,
    summary: source.image_version && current.image_version && source.image_version !== current.image_version
      ? `YouEye ${source.image_version} recovery data can be migrated by this YouEye ${current.image_version} server.`
      : 'This recovery point matches the current YouEye compatibility boundary.',
  };
}
