import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('Pointer is a statically managed app with an app-scoped release channel', () => {
  const definitions = read('src/lib/apps/definitions.ts');
  assert.match(definitions, /id: 'pointer',[\s\S]*?releaseChannelKey: 'app:pointer'/);
  assert.match(definitions, /giteaRepo: 'Pointer'/);
  assert.match(definitions, /healthEndpoint: '\/readyz'/);
});

test('Pointer candidate resolution and updates use the exact app channel', () => {
  const checks = read('src/lib/apps/lxd-updates.ts');
  const channels = read('src/app/api/updates/channels/route.ts');
  const route = read('src/app/api/apps/[name]/update/route.ts');
  const infrastructureDeployer = read('src/lib/infrastructure/deployer.ts');
  const lxdDeployer = read('src/lib/infrastructure/lxd-deployer.ts');
  assert.match(checks, /resolveLxdAppChannel/);
  assert.match(checks, /effectiveChannel\(appDef\.releaseChannelKey/);
  assert.match(checks, /resolveCandidate\(channel, appDef\.lxdConfig\.tagPrefix \?\? null\)/);
  assert.match(channels, /checkLxdAppUpdate\(appDef, true\)/);
  assert.match(route, /resolveLxdAppChannel\(appDef\)/);
  assert.match(route, /artifactSHA256: resolved\.candidate\.artifactSHA256/);
  assert.match(route, /await updateLXDApp\(appDef, emit, \{/);
  assert.match(infrastructureDeployer, /giteaRepo: 'Pointer',[\s\S]*releaseChannelKey: 'app:pointer'/);
  assert.match(lxdDeployer, /effectiveChannel\(cfg\.releaseChannelKey \|\| 'ui'\)/);
  assert.match(infrastructureDeployer, /await configurePointerService\(\);[\s\S]*recordCoreProvenance\('app:pointer'/);
  assert.match(infrastructureDeployer, /tag: resolved\.tag/);
  assert.match(infrastructureDeployer, /artifactSHA256: resolved\.artifactSHA256/);
  assert.match(lxdDeployer, /\.youeye-artifact-sha256/);
  assert.match(lxdDeployer, /return \{ \.\.\.release, artifactSHA256 \}/);
});

test('Pointer channel and exact installed provenance are exposed to Infra', () => {
  const channels = read('src/app/api/updates/channels/route.ts');
  const unified = read('src/app/api/apps/unified/route.ts');
  const updater = read('src/lib/apps/lxd-updater.ts');
  assert.match(channels, /APP_DEFINITIONS/);
  assert.match(channels, /staticChannelKeys/);
  assert.match(unified, /def\.releaseChannelKey \? def\.releaseChannelKey/);
  assert.match(updater, /recordCoreProvenance\(appDef\.releaseChannelKey/);
  assert.match(updater, /tag: override\.tag/);
  assert.match(updater, /artifactSHA256: override\.artifactSHA256/);
});

test('unified apps remains compatible with Spine responses that omit runtime', () => {
  const unified = read('src/app/api/apps/unified/route.ts');
  assert.match(unified, /status\?\.runtime\?\.kind/);
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
  assert.match(setup, /shouldRunStep\('ai'\)[\s\S]*configurePointerForPlatform\(\)[\s\S]*saveStepState\('ai', 'done'\)/);
  assert.match(setupPage, /id: 'ai', label: t\('configuringAi'\)/);
  assert.match(reconfigure, /step: 'ai', status: 'running'[\s\S]*configurePointerForPlatform\(\)/);
});
