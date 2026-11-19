import { spineClient, type SpineStatusResponse } from '@/lib/spine/client';
import type { BackupRelease, BackupSourceIdentity } from './types';
import { compareLines, compareReleases, compareVersions, isBuildName, releaseLine, validReleaseKey } from '@/lib/version';
import type { CoreRelease } from '@/lib/releases/core-release';
import type { VerifiedProductRelease } from '@/lib/releases/product-release';

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

function optionalRelease(value: unknown, field: string): BackupRelease | undefined {
  if (value === undefined || value === null) return undefined;
  const r = value as Partial<BackupRelease>;
  if (!r || typeof r !== 'object' || Array.isArray(r) || typeof r.version !== 'string' || r.version.length < 1 || r.version.length > 128
    || !validReleaseKey({ line: r.line, sequence: r.sequence }) || typeof r.source_tree !== 'string' || !/^[0-9a-f]{40}$/.test(r.source_tree)) {
    throw new Error(`Backup ${field} release is invalid.`);
  }
  return { version: r.version, line: r.line!, sequence: r.sequence!, source_tree: r.source_tree };
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
    source_tree: optionalText(candidate.source_tree, 'source identity'),
    state_schema_version: optionalPositiveInteger(candidate.state_schema_version, 'State schema'),
    data_schema_version: optionalPositiveInteger(candidate.data_schema_version, 'Data schema'),
    disk_layout_version: optionalPositiveInteger(candidate.disk_layout_version, 'disk layout'),
    spine_version: candidate.spine_version,
    control_panel_version: optionalText(candidate.control_panel_version, 'Server interface version'),
    ui_version: optionalText(candidate.ui_version, 'UI version'),
    pointer_version: optionalText(candidate.pointer_version, 'Pointer version'),
  };
  // Release keys (from 0.6.12); a backup made before has only the build names above.
  for (const [field, label] of [['release', 'YouEye'], ['control_panel', 'Server interface'], ['ui', 'UI'], ['pointer', 'Pointer']] as const) {
    const release = optionalRelease(candidate[field], label);
    if (release) parsed[field] = release;
  }
  if (parsed.runtime_kind === 'appliance-image'
    && (!parsed.image_version || !parsed.source_tree || !parsed.state_schema_version || !parsed.data_schema_version)) {
    throw new Error('Recovery point has an incomplete appliance compatibility identity.');
  }
  if (parsed.source_tree && !/^[0-9a-f]{40}$/.test(parsed.source_tree)) {
    throw new Error('Backup source identity is invalid.');
  }
  return parsed;
}

/** The releases a backup records: the accepted System release and Pointer's installed release. */
export interface BackupReleases {
  core?: CoreRelease | null;
  pointer?: VerifiedProductRelease | null;
}

function backupRelease(release: { version: string; sequence: number; source_tree: string }, sourceTree = release.source_tree): BackupRelease {
  return { version: release.version, line: releaseLine(release.version)!, sequence: release.sequence, source_tree: sourceTree };
}

/**
 * Builds this box's source identity from a Spine status response (`GET
 * /api/status`) and the installed releases. The Control Panel, UI and Pointer
 * are recorded by release (version, line, sequence, git tree) and, for an
 * older Control Panel, by their old build names (a new-shape release has
 * none: its version stands in).
 */
export function backupSourceIdentityFromStatus(status: SpineStatusResponse, pointerVersion?: string, releases: BackupReleases = {}): BackupSourceIdentity {
  if (status.runtime.kind === 'appliance-image') {
    if (!status.runtime.manifest_valid || status.runtime.repair_required
      || !status.persistent_state?.compatibility.compatible
      || status.persistent_state.compatibility.repair_required) {
      throw new Error('YouEye System compatibility must be healthy before creating or restoring a recovery point.');
    }
  }
  const { core, pointer } = releases;
  const member = (role: string) => core?.members.find(m => m.role === role);
  const cp = member('cp'), ui = member('ui');
  return parseBackupSourceIdentity({
    schema: 'youeye.backup.source.v1',
    runtime_kind: status.runtime.kind,
    image_version: status.runtime.image_version,
    source_tree: status.runtime.source_tree,
    state_schema_version: status.persistent_state?.state_schema_version,
    data_schema_version: status.persistent_state?.data_schema_version,
    disk_layout_version: status.persistent_state?.disk_layout_version ?? status.runtime.disk_layout_version,
    spine_version: status.spine.version,
    control_panel_version: cp ? cp.build_version ?? core!.version : status.control_panel.version,
    ui_version: ui ? ui.build_version ?? core!.version : status.ui?.version,
    pointer_version: pointer ? pointer.build.build_version ?? pointer.release.version : pointerVersion,
    ...(core ? { release: backupRelease(core) } : {}),
    ...(core && cp ? { control_panel: backupRelease(core, cp.source_tree) } : {}),
    ...(core && ui ? { ui: backupRelease(core, ui.source_tree) } : {}),
    ...(pointer ? { pointer: backupRelease(pointer.release) } : {}),
  });
}

export async function readCurrentBackupSourceIdentity(): Promise<BackupSourceIdentity> {
  const { pointerRelease, readPointerReleaseState } = await import('@/lib/pointer/release-metadata');
  const { loadSelectedCore } = await import('@/lib/releases/core-release');
  // A damaged Pointer record must not block backups; the identity then omits Pointer.
  const pointer = await readPointerReleaseState().then(pointerRelease).catch(() => null);
  // Not an appliance (no accepted release): the Control Panel and UI are named as Spine reports them.
  let core: CoreRelease | null = null;
  try { core = loadSelectedCore(); } catch { /* no accepted System release */ }
  return backupSourceIdentityFromStatus(await spineClient.status(), undefined, { core, pointer });
}

const COMPONENTS = [
  ['control_panel', 'control_panel_version', 'Control Panel'],
  ['ui', 'ui_version', 'UI'],
  ['pointer', 'pointer_version', 'Pointer'],
] as const;

/**
 * Order of a component in a backup against what the box runs: >0 when the
 * backup was made by newer software. The release key decides (the same git
 * tree is the same software). A backup made before 0.6.12 has only a build
 * name: it is compared by line, and within one line by the old build rule
 * against the box's own build name when it has one.
 */
function backupComponentOrder(source: BackupSourceIdentity, current: BackupSourceIdentity,
  key: 'control_panel' | 'ui' | 'pointer', build: 'control_panel_version' | 'ui_version' | 'pointer_version'): number {
  const made = source[key], running = current[key];
  if (made && running) return made.source_tree === running.source_tree ? 0 : compareReleases(made, running);
  const madeBuild = source[build], runningBuild = current[build];
  if (!madeBuild || !(running || runningBuild)) return 0;
  const madeLine = releaseLine(madeBuild), runningLine = running?.line ?? (runningBuild ? releaseLine(runningBuild) : null);
  // Versions from before release names (e.g. 0.5.x numeric builds): the old rule.
  if (!madeLine || !runningLine) return runningBuild ? compareVersions(madeBuild, runningBuild) : 0;
  const lines = compareLines(madeLine, runningLine);
  // Within one line the old build rule orders two build names (`-dev.N`) only. The old field may hold a release
  // name (`0.6.13-beta.1`, written for a release without build names) or a line (a Spine's own version): a label,
  // compared by line only.
  if (lines || !isBuildName(madeBuild) || !isBuildName(runningBuild)) return lines;
  return compareVersions(madeBuild, runningBuild);
}

/** What a backup shows as the YouEye it was made by: the release version; nothing for an older backup. */
export function backupYouEyeVersion(source: BackupSourceIdentity | undefined): string | undefined {
  return source?.release?.version;
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
  // Releases only move forward: an older Control Panel, UI or Pointer must not
  // open data that newer software may already have migrated.
  for (const [key, build, label] of COMPONENTS) {
    if (backupComponentOrder(source, current, key, build) > 0) {
      const made = (key === 'pointer' ? source.pointer?.version : source.release?.version) ?? source[build];
      const running = (key === 'pointer' ? current.pointer?.version : current.release?.version) ?? current[build];
      const versions = made && running ? ` (${made}; this box runs ${running})` : '';
      return { compatible: false, summary: `This recovery point was created by a newer ${label}${versions}. Update this box before restoring it.` };
    }
  }
  const made = backupYouEyeVersion(source), running = backupYouEyeVersion(current);
  return {
    compatible: true,
    summary: made && running && made !== running
      ? `YouEye ${made} recovery data can be migrated by this YouEye ${running} server.`
      : 'This recovery point matches the current YouEye compatibility boundary.',
  };
}
