import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('integration manifests can declare uninstall and rollback steps', () => {
  const schema = read('src/lib/market/schema.ts');

  assert.match(schema, /uninstall:\s*SSOSetupSchema\.optional\(\)/);
  assert.match(schema, /rollback:\s*SSOSetupSchema\.optional\(\)/);
});

test('market catalog exposes whether an integration has uninstall steps', () => {
  const catalog = read('src/lib/market/catalog.ts');
  const types = read('src/lib/market/types.ts');

  assert.match(types, /hasUninstall\?: boolean/);
  assert.match(catalog, /hasUninstall:\s*!!manifest\.uninstall/);
});

test('integration runner supports remove with teardown or explicit metadata-only removal', () => {
  const runner = read('src/lib/market/integration-runner.ts');
  const routePath = 'src/app/api/market/integrations/remove/route.ts';

  assert.equal(existsSync(join(repoRoot, routePath)), true);
  assert.match(runner, /export async function removeIntegration/);
  assert.match(runner, /executeIntegrationTeardown/);
  assert.match(runner, /does not declare uninstall steps/);
  assert.match(runner, /metadataOnly/);
  assert.match(read(routePath), /removeIntegration/);
});

test('integration detail page can remove installed integrations', () => {
  const page = read('src/app/market/[appId]/page.tsx');

  assert.match(page, /handleRemoveIntegration/);
  assert.match(page, /\/api\/market\/integrations\/remove/);
  assert.match(page, /Remove record/);
  assert.match(page, /hasUninstall/);
});
