/**
 * Config file writer for youeye-file.yaml manifests.
 * Writes template-based config files to host volumes BEFORE container start.
 *
 * Also reads language config from the manifest and injects the language
 * environment variable into the container during install.
 */

import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { resolveVariables } from './variables';
import type { AppManifest, ConfigFileSpec, VariableContext } from './types';

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
function parsePermission(perm: string): number {
  if (perm.startsWith('0o')) {
    return parseInt(perm.slice(2), 8);
  }
  return parseInt(perm, 8);
}

/**
 * Write a single config file from a template with variable substitution.
 */
export async function writeConfigFile(
  spec: ConfigFileSpec,
  ctx: Partial<VariableContext>
): Promise<void> {
  const resolvedPath = resolveVariables(spec.path, ctx);
  const content = resolveVariables(spec.template, ctx);
  const filePermission = parsePermission(spec.permission);
  const dirPermission = parsePermission(spec.directoryPermission);

  const dir = path.dirname(resolvedPath);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true, mode: dirPermission });
  }

  await writeFile(resolvedPath, content, { mode: filePermission });
}

/**
 * Write all config files from a manifest.
 */
export async function writeAllConfigFiles(
  configFiles: ConfigFileSpec[],
  ctx: Partial<VariableContext>
): Promise<void> {
  for (const spec of configFiles) {
    await writeConfigFile(spec, ctx);
  }
}

/**
 * Read the language config from a manifest and return the env var name + value
 * that should be set on each container.
 *
 * Returns null if the manifest has no language config.
 */
export function readLanguageConfig(
  manifest: AppManifest,
  systemLang: string
): { envVar: string; value: string } | null {
  if (!manifest.language) return null;

  const { env_var, format } = manifest.language;
  const value = format === 'full'
    ? (FULL_LANG_NAMES[systemLang] || 'english')
    : systemLang;

  return { envVar: env_var, value };
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
