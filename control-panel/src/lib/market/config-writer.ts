/**
 * Config file writer for youeye-file.yaml manifests.
 * Renders template-based config files directly into their Incus custom volumes
 * before OCI containers start. LXD callers may still target an instance path.
 *
 * Also reads language config from the manifest and injects the language
 * environment variable into the container during install.
 */

import { resolveVariables } from './variables';
import type { AppManifest, ConfigFileSpec, StorageVolumeMeta, VariableContext } from './types';
import {
  execCommand,
  incusCreateVolumeDirectory,
  incusDownloadFile,
  incusDownloadVolumeFile,
  incusInspectVolumeFile,
  incusUploadFile,
  incusUploadVolumeFile,
} from '../incus/server';
import path from 'path';

/** Full-word language names for manifests that use format: "full" */
const FULL_LANG_NAMES: Record<string, string> = {
  en: 'english',
  ru: 'russian',
  es: 'spanish',
  de: 'german',
  fr: 'french',
};

/**
 * Parse an octal permission string like "0o644" to a number.
 */
function permissionDigits(permission: string): string {
  if (!/^(?:0o)?[0-7]{3,4}$/.test(permission)) {
    throw new Error('App configuration permission is invalid');
  }
  const digits = permission.startsWith('0o') ? permission.slice(2) : permission;
  const parsed = Number.parseInt(digits, 8);
  if (parsed > 0o7777) throw new Error('App configuration permission is invalid');
  return parsed.toString(8).padStart(4, '0');
}

function resolvedConfigPath(spec: ConfigFileSpec, ctx: Partial<VariableContext>): string {
  const resolvedPath = resolveVariables(spec.path, ctx);
  if (!resolvedPath.startsWith('/') || resolvedPath.includes('\0') || path.posix.normalize(resolvedPath) !== resolvedPath) {
    throw new Error('App configuration target is invalid');
  }
  return resolvedPath;
}

/**
 * Write a single config file from a template with variable substitution.
 */
export async function writeConfigFile(
  containerName: string,
  spec: ConfigFileSpec,
  ctx: Partial<VariableContext>
): Promise<void> {
  const resolvedPath = resolvedConfigPath(spec, ctx);
  const content = Buffer.from(resolveVariables(spec.template, ctx), 'utf8');
  const filePermission = permissionDigits(spec.permission);
  permissionDigits(spec.directoryPermission);
  await incusUploadFile(containerName, resolvedPath, content, {
    mode: filePermission,
    createDirs: true,
  });
  if (!content.equals(await incusDownloadFile(containerName, resolvedPath))) {
    throw new Error('App configuration did not read back exactly');
  }
}

/**
 * Re-assert manifest permissions after the container's entrypoint has run.
 * OCI entrypoints commonly chown mounted configuration trees at startup. The
 * Incus files API sets the file mode before first boot; this second exact
 * check also tightens the mounted directory and catches entrypoints that
 * broaden either mode.
 */
export async function enforceConfigFilePermissions(
  containerName: string,
  spec: ConfigFileSpec,
  ctx: Partial<VariableContext>
): Promise<void> {
  const resolvedPath = resolvedConfigPath(spec, ctx);
  const targets = [
    { path: path.posix.dirname(resolvedPath), mode: permissionDigits(spec.directoryPermission) },
    { path: resolvedPath, mode: permissionDigits(spec.permission) },
  ];

  for (const target of targets) {
    const chmod = await execCommand(containerName, ['chmod', target.mode, target.path], { timeout: 10_000 });
    if (chmod.exitCode !== 0) throw new Error('App configuration permissions could not be applied');
    const stat = await execCommand(containerName, ['stat', '-c', '%a', target.path], { timeout: 10_000 });
    const expected = target.mode.replace(/^0+/, '') || '0';
    if (stat.exitCode !== 0 || stat.stdout.trim() !== expected) {
      throw new Error('App configuration permissions did not read back exactly');
    }
  }
}

export async function enforceAllConfigFilePermissions(
  configFiles: ConfigFileSpec[],
  logicalContainerName: string,
  runtimeContainerName: string,
  ctx: Partial<VariableContext>
): Promise<void> {
  for (const spec of configFiles.filter((candidate) => candidate.container === logicalContainerName)) {
    await enforceConfigFilePermissions(runtimeContainerName, spec, ctx);
  }
}

/**
 * Write all config files from a manifest.
 */
export interface ConfigVolumeTarget {
  pool: string;
  volume: string;
  path: string;
  readOnly: boolean;
}

export interface ConfigStorageMount {
  containerPath: string;
  readOnly: boolean;
  ephemeral: boolean;
}

function normalizedMountPath(mount: string): string {
  return mount === '/' ? '/' : mount.replace(/\/$/, '');
}

function pathInsideMount(target: string, mount: string): boolean {
  return mount === '/' ? target.startsWith('/') : target === mount || target.startsWith(`${mount}/`);
}

function relativePathInMount(target: string, mount: string): string {
  return mount === '/' ? target.slice(1) : target.slice(mount.length).replace(/^\//, '');
}

export function deepestConfigStorageMount<T extends ConfigStorageMount>(
  mounts: T[],
  target: string,
): { mount: T; relativePath: string } | null {
  const match = mounts.reduce<{ mount: T; normalized: string } | null>((current, mount) => {
    const normalized = normalizedMountPath(mount.containerPath);
    if (!pathInsideMount(target, normalized)) return current;
    return !current || normalized.length > current.normalized.length ? { mount, normalized } : current;
  }, null);
  if (!match) return null;
  return { mount: match.mount, relativePath: relativePathInMount(target, match.normalized) };
}

export function configVolumeTarget(
  spec: ConfigFileSpec,
  volumes: StorageVolumeMeta[],
  ctx: Partial<VariableContext>,
): ConfigVolumeTarget {
  const resolvedPath = resolvedConfigPath(spec, ctx);
  const match = deepestConfigStorageMount(
    volumes.map((volume) => ({ ...volume, ephemeral: false })),
    resolvedPath,
  );
  if (!match) throw new Error('App configuration does not resolve to durable app storage');
  if (!match.relativePath) throw new Error('App configuration must target a file inside durable app storage');
  const volumePath = [match.mount.sourcePath, match.relativePath].filter(Boolean).join('/');
  return {
    pool: match.mount.pool,
    volume: match.mount.name,
    path: `/${volumePath}`,
    readOnly: match.mount.readOnly,
  };
}

async function ensureVolumeConfigParent(target: ConfigVolumeTarget, mode: string): Promise<void> {
  const parent = path.posix.dirname(target.path);
  if (parent === '/') {
    const root = await incusInspectVolumeFile(target.pool, target.volume, '/');
    if (!root || root.type !== 'directory') {
      throw new Error('App configuration directory is unavailable in durable storage');
    }
    return;
  }

  const segments = parent.split('/').filter(Boolean);
  let current = '';
  for (const [index, segment] of segments.entries()) {
    current += `/${segment}`;
    const expectedMode = index === segments.length - 1 ? mode : '0755';
    const existing = await incusInspectVolumeFile(target.pool, target.volume, current);
    if (!existing) {
      await incusCreateVolumeDirectory(target.pool, target.volume, current, expectedMode);
      continue;
    }
    if (existing.type !== 'directory') throw new Error('App configuration parent is not a directory');
    if (index === segments.length - 1 && existing.mode !== mode) {
      throw new Error('App configuration directory permissions do not match durable storage');
    }
  }
}

export async function readConfigFile(
  containerName: string,
  spec: ConfigFileSpec,
  ctx: Partial<VariableContext>,
  volumes?: StorageVolumeMeta[],
): Promise<Buffer> {
  if (!volumes) return incusDownloadFile(containerName, resolvedConfigPath(spec, ctx));
  const target = configVolumeTarget(spec, volumes, ctx);
  return incusDownloadVolumeFile(target.pool, target.volume, target.path);
}

export async function writeConfigFileToStorage(
  containerName: string,
  spec: ConfigFileSpec,
  ctx: Partial<VariableContext>,
  volumes?: StorageVolumeMeta[],
  content = Buffer.from(resolveVariables(spec.template, ctx), 'utf8'),
): Promise<void> {
  const filePermission = permissionDigits(spec.permission);
  const directoryPermission = permissionDigits(spec.directoryPermission);
  if (!volumes) {
    const resolvedPath = resolvedConfigPath(spec, ctx);
    await incusUploadFile(containerName, resolvedPath, content, { mode: filePermission, createDirs: true });
    if (!content.equals(await incusDownloadFile(containerName, resolvedPath))) {
      throw new Error('App configuration did not read back exactly');
    }
    return;
  }
  const target = configVolumeTarget(spec, volumes, ctx);
  if (target.readOnly) throw new Error('App configuration cannot target read-only storage');
  const existingFile = await incusInspectVolumeFile(target.pool, target.volume, target.path);
  if (existingFile?.type !== undefined && existingFile.type !== 'file') {
    throw new Error('App configuration target is not a regular file');
  }
  if (existingFile && existingFile.mode !== filePermission) {
    throw new Error('App configuration file permissions do not match durable storage');
  }
  await ensureVolumeConfigParent(target, directoryPermission);
  await incusUploadVolumeFile(target.pool, target.volume, target.path, content, { mode: filePermission });
  if (!content.equals(await incusDownloadVolumeFile(target.pool, target.volume, target.path))) {
    throw new Error('App configuration did not read back exactly from durable storage');
  }
  const file = await incusInspectVolumeFile(target.pool, target.volume, target.path);
  if (!file || file.type !== 'file' || file.mode !== filePermission) {
    throw new Error('App configuration file permissions do not match durable storage');
  }
}

export async function writeAllConfigFiles(
  configFiles: ConfigFileSpec[],
  logicalContainerName: string,
  runtimeContainerName: string,
  ctx: Partial<VariableContext>,
  volumes?: StorageVolumeMeta[],
): Promise<void> {
  for (const spec of configFiles.filter((candidate) => candidate.container === logicalContainerName)) {
    await writeConfigFileToStorage(runtimeContainerName, spec, ctx, volumes);
  }
}

/**
 * Read the language config from a manifest and return the env var name + value
 * that should be set on each container.
 *
 * Returns null if the manifest has no language config.
 */
export function readLanguageConfig(
  _manifest: AppManifest,
  _systemLang: string
): { envVar: string; value: string } | null {
  // Language is now handled via env_mapping with ${platform.locale}
  return null;
}

/**
 * Inject the language environment variable into every container spec
 * in the manifest.  Mutates containerSpec.environment in place.
 *
 * Called by the install engine AFTER config files are written and BEFORE
 * containers are deployed, so that the first boot already has the
 * correct language.
 */
export function applyLanguageToContainers(
  manifest: AppManifest,
  systemLang: string
): void {
  const langConfig = readLanguageConfig(manifest, systemLang);
  if (!langConfig) return;

  for (const containerSpec of manifest.containers) {
    containerSpec.environment[langConfig.envVar] = langConfig.value;
  }
}
