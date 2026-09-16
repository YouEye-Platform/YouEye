/**
 * Core-component provenance (CP side).
 *
 * Provenance for spine + control lives spine-side (core-provenance.json, written
 * by `spine update self/control`). CP owns provenance for the components IT
 * updates: the UI (and, in general, anything the Control Panel deploys directly).
 *
 * Stored in CP's json-store at state/core-versions.json:
 *   { "ui": { version, tag, branch, source, updated_at } }
 *
 * This lets the Settings → Updates surface and the channel-aware checker tell
 * "update within my channel" from "channel switch" for the UI.
 */

import { readJSON, writeJSON, statePath } from '@/lib/storage/json-store';

const STORE_PATH = statePath('core-versions.json');

export interface CoreProvenance {
  version: string;
  tag: string | null;
  branch: string | null;
  source: string | null;
  artifact_sha256?: string | null;
  updated_at: string;
}

type CoreVersionsStore = Record<string, CoreProvenance>;

/** Read the provenance record for a core component CP manages (e.g. "ui"). */
export async function getCoreProvenance(component: string): Promise<CoreProvenance | null> {
  const store = (await readJSON<CoreVersionsStore>(STORE_PATH)) ?? {};
  return store[component] ?? null;
}

/** Read the whole core-versions store. */
export async function getAllCoreProvenance(): Promise<CoreVersionsStore> {
  return (await readJSON<CoreVersionsStore>(STORE_PATH)) ?? {};
}

/**
 * Record provenance for a core component CP just deployed (e.g. "ui" after an
 * updateLXDApp run). Overwrites the component's record atomically.
 */
export async function recordCoreProvenance(
  component: string,
  provenance: {
    version: string;
    tag?: string | null;
    branch?: string | null;
    source?: string | null;
    artifactSHA256?: string | null;
  },
): Promise<void> {
  const store = (await readJSON<CoreVersionsStore>(STORE_PATH)) ?? {};
  store[component] = {
    version: provenance.version,
    tag: provenance.tag ?? null,
    branch: provenance.branch ?? null,
    source: provenance.source ?? null,
    artifact_sha256: provenance.artifactSHA256 ?? null,
    updated_at: new Date().toISOString(),
  };
  await writeJSON(STORE_PATH, store);
}
