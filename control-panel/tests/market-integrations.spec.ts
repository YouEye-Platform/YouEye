import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('market manifests support optional integrations', () => {
  const schema = read('src/lib/market/schema.ts');
  const types = read('src/lib/market/types.ts');

  assert.match(schema, /IntegrationSchema/);
  assert.match(schema, /integrations:\s*z\.array\(IntegrationSchema\)/);
  assert.match(types, /selectedIntegrations\?: string\[\]/);
});

test('legacy api and cli SSO setup is exposed as the identity provider integration', () => {
  const catalog = read('src/lib/market/catalog.ts');
  const engine = read('src/lib/market/engine.ts');

  assert.match(catalog, /id:\s*'youeye-id'/);
  assert.match(catalog, /installByDefault:\s*true/);
  assert.match(engine, /LEGACY_IDENTITY_PROVIDER_INTEGRATION = 'youeye-id'/);
  assert.match(engine, /config\.selectedIntegrations \?\? getDefaultSelectedIntegrations/);
  assert.match(engine, /selectedIntegrations\.includes\(LEGACY_IDENTITY_PROVIDER_INTEGRATION\)/);
});

test('market install UIs send selected integrations', () => {
  // The market embed client (src/app/embed/market/client.tsx) was consolidated
  // into the single shared install dialog — it is now the one install UI that
  // sends the selected integrations, so assert on it directly.
  const dialog = read('src/components/market/install-dialog.tsx');

  assert.match(dialog, /selectedIntegrations:/);
  assert.match(dialog, /integrationToggles/);
});
