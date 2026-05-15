/**
 * YAML parser for youeye-app.yaml manifests.
 * Parses YAML text and validates against the AppManifest schema.
 */

import { parse as parseYAML } from 'yaml';
import { AppManifestSchema, CatalogSchema } from './schema';
import type { AppManifest, Catalog } from './types';

/**
 * Parse and validate a youeye-app.yaml manifest.
 * Throws on invalid YAML or schema validation failure.
 */
export function parseManifest(yamlText: string): AppManifest {
  const raw = parseYAML(yamlText);
  return AppManifestSchema.parse(raw);
}

/**
 * Parse and validate a catalog.yaml file.
 */
export function parseCatalog(yamlText: string): Catalog {
  const raw = parseYAML(yamlText);
  return CatalogSchema.parse(raw);
}

/**
 * Try to parse a manifest, returning errors instead of throwing.
 */
export function tryParseManifest(yamlText: string): { success: true; data: AppManifest } | { success: false; error: string } {
  try {
    const data = parseManifest(yamlText);
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
