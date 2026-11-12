import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('Pointer is a statically managed app resolved through the channel index', () => {
  const definitions = read('src/lib/apps/definitions.ts');
  assert.match(definitions, /id: 'pointer',/);
  assert.doesNotMatch(definitions, /releaseChannelKey|giteaRepo|tagPrefix/);
  assert.match(definitions, /healthEndpoint: '\/readyz'/);
});

test('Pointer candidate resolution and updates use the box channel index', () => {
  const checks = read('src/lib/apps/lxd-updates.ts');
  const route = read('src/app/api/apps/[name]/update/route.ts');
  const infrastructureDeployer = read('src/lib/infrastructure/deployer.ts');
  const lxdDeployer = read('src/lib/infrastructure/lxd-deployer.ts');
  const updater = read('src/lib/apps/lxd-updater.ts');
  assert.match(checks, /readChannelIndex\(\)\)\.index\.products\.pointer/);
  assert.doesNotMatch(checks, /effectiveChannel|resolveCandidate|package\.json/);
  assert.match(route, /await withUserOperationLockWait\(\(\) => updateLXDApp\(appDef, emit\)\)/);
  assert.match(infrastructureDeployer, /resolve: \(\) => resolveNativeProduct\('pointer'\)/);
  assert.match(infrastructureDeployer, /tag: resolved\.tag/);
  assert.match(infrastructureDeployer, /artifactSHA256: resolved\.artifactSHA256/);
  assert.match(lxdDeployer, /export async function resolveUIRelease/);
  assert.match(lxdDeployer, /releaseAssetURL\(repository, selected\.release\.tag, artifact\)/);
  assert.doesNotMatch(lxdDeployer, /effectiveChannel|releaseChannelKey|giteaBaseURL/);
  assert.match(lxdDeployer, /\.youeye-artifact-sha256/);
  assert.match(lxdDeployer, /return \{ \.\.\.release, artifactSHA256 \}/);
  assert.match(updater, /resolveNativeProduct\('pointer'\)/);
  assert.match(updater, /updates with the System release/);
});


test('Pointer waits for a real setup issuer and is refreshed on every domain change', () => {
  const deployer = read('src/lib/infrastructure/deployer.ts');
  const lifecycle = read('src/lib/pointer/lifecycle.ts');
  const setup = read('src/app/api/setup/run/route.ts');
  const setupPage = read('src/app/setup/page.tsx');
  const reconfigure = read('src/lib/reconfigure/index.ts');

  assert.match(deployer, /hasPointerIdentitySettings/);
  assert.match(deployer, /AI service deferred until setup configures the platform domain/);
  assert.match(deployer, /deferPointerServiceUntilSetup/);
  assert.match(deployer, /export async function configurePointerForPlatform/);
  assert.match(deployer, /exists \? await getCoreProvenance\('app:pointer'\) : null/);
  assert.match(deployer, /exists && !provenance[\s\S]*deployPointerContainerFromConfiguredSource\(true\)/);
  assert.match(lifecycle, /systemctl', 'disable', '--now', 'youeye-pointer\.service'/);
  assert.match(lifecycle, /systemctl', 'enable', 'youeye-pointer\.service'/);
  assert.match(lifecycle, /systemctl', 'restart', 'youeye-pointer\.service'/);
  assert.match(setup, /ai\?: StepState/);
  assert.match(setup, /configurePointerForPlatform\(undefined, \{ deferRoutes: true \}\)[\s\S]*saveStepState\('ai', 'done'\)/);
  assert.ok(setup.indexOf("await settingsService.setRaw({") < setup.indexOf('await configurePointerForPlatform('),
    'Pointer must use the persisted setup-selected identity');
  assert.match(setup, /reconcileManagedRoutes\(domain, \{\}, \{ pointer: false \}\)/,
    'Caddy setup must not depend on the AI service');
  assert.ok(setup.indexOf('await configurePointerForPlatform(') < setup.indexOf('reconcileManagedRoutes(body.domain, {}, { pointer: true })'),
    'Pointer route verification must follow Pointer provisioning');
  assert.ok(setup.indexOf('reconcileManagedRoutes(domain, {}, { pointer: false })') < setup.indexOf('await configurePointerForPlatform('),
    'the AI step runs after Caddy setup');
  assert.match(setup, /console\.error\(`\[setup\] YouEye AI service \$\{stage\} failed:`, err\)[\s\S]*saveStepState\('ai', 'error', reason\)/,
    'AI step failures are logged and their reason persisted');
  assert.match(setupPage, /id: 'ai', label: t\('configuringAi'\)/);
  assert.match(reconfigure, /step: 'ai', status: 'running'[\s\S]*configurePointerForPlatform\(undefined, \{ deferRoutes: true \}\)[\s\S]*reconcileManagedRoutes\(activeConfig\.domain\)/);
  assert.match(deployer, /Verifying YouEye AI service health[\s\S]*await configurePointerService\(\)/);
});

test('static updates require admin and CSRF before streaming and share lifecycle exclusion', () => {
  const route = read('src/app/api/apps/[name]/update/route.ts');
  const updater = read('src/lib/apps/lxd-updater.ts');
  const stream = route.indexOf('new ReadableStream');
  assert.ok(route.indexOf('if (!session.isAdmin)') < stream);
  assert.ok(route.indexOf('await verifyCSRFToken') < stream);
  assert.match(updater, /withAppLifecycle\(appDef\.id, \(\) => updateLXDAppUnderLifecycle\(appDef, emit\)\)/);
  assert.ok(updater.indexOf('await configurePointerService();') > updater.indexOf("tar -xf /tmp/update.tar"));
});
