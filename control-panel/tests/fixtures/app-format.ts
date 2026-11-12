/** Build internal app models from `youeye.app.v1` documents written as objects. */
import { stringify } from 'yaml';
import { loadApp } from '../../src/lib/market/app-format/compile';
import type { AppManifest } from '../../src/lib/market/types';

export const PIN = `@sha256:${'a'.repeat(64)}`;

/** A minimal valid container app; `changes` replace top-level keys (undefined removes one). */
export function appDocument(changes: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schema: 'youeye.app.v1',
    id: 'demo',
    version: '1.0.0',
    name: 'Demo',
    listing: { description: 'Demo app', category: 'utilities', icon: 'box' },
    image: `ghcr.io/example/demo${PIN}`,
    port: 8080,
    health: '/health',
  };
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

export function appYAML(changes: Record<string, unknown> = {}): string {
  return stringify(appDocument(changes), { aliasDuplicateObjects: false });
}

/** Compile a document (strict parser) into the engine's internal model. */
export function appFixture(changes: Record<string, unknown> = {}, setups: Record<string, unknown> = {}): AppManifest {
  return loadApp({
    manifest: appYAML(changes),
    setups: Object.fromEntries(Object.entries(setups).map(([name, value]) => [name, typeof value === 'string' ? value : stringify(value, { aliasDuplicateObjects: false })])),
  });
}

/** A minimal valid native app. */
export function nativeFixture(changes: Record<string, unknown> = {}): AppManifest {
  return appFixture({ image: undefined, source: { node: '24' }, port: 3000, health: '/api/health', ...changes });
}
