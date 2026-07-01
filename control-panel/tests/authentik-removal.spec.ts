import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const youEyeRoot = join(repoRoot, 'YouEye');
const controlPanelRoot = join(youEyeRoot, 'control-panel');
const marketRoot = join(repoRoot, 'Market');

function read(relativePath: string): string {
  return readFileSync(join(controlPanelRoot, relativePath), 'utf8');
}

test('fresh infrastructure deploy does not install or reconcile Authentik', () => {
  const deployer = read('src/lib/infrastructure/deployer.ts');

  assert.doesNotMatch(deployer, /authentikServerManifest|authentikWorkerManifest/);
  assert.doesNotMatch(deployer, /setupAuthentikDatabase|createAuthentikAPIToken|setupCaddyAuthentikRoute/);
  assert.doesNotMatch(deployer, /youeye-authentik/);
  assert.match(deployer, /const TOTAL_STEPS = 4;/);
  assert.match(deployer, /const RECONCILE_STEPS = 4;/);
});

test('setup flow creates YouEye ID routes and users without Authentik', () => {
  const setup = read('src/app/api/setup/run/route.ts');

  assert.doesNotMatch(setup, /container: 'youeye-authentik'|subs\.auth/);
  assert.doesNotMatch(setup, /getAuthentikConfig|authentikAPI|youeye-authentik/);
  assert.match(setup, /ensureIdentityAdminUser/);
  assert.match(setup, /ensureIdentityRoute/);
});

test('system app catalog no longer advertises Authentik', () => {
  const catalog = readFileSync(join(marketRoot, 'catalog.yaml'), 'utf8');

  assert.doesNotMatch(catalog, /id:\s+authentik/);
  assert.equal(existsSync(join(marketRoot, 'system', 'authentik.yaml')), false);
});
