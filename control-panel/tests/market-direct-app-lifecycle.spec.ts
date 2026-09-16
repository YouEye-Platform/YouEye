import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function source(path: string) {
  return readFile(join(process.cwd(), path), 'utf8');
}

test('direct manifests become instance-local Market entries and open the normal detail page', async () => {
  const validator = await source('src/app/api/market/validate-url/route.ts');
  const dialog = await source('src/components/market/install-from-url-dialog.tsx');
  const catalog = await source('src/app/api/market/catalog/route.ts');
  const detail = await source('src/app/api/market/app/[appId]/route.ts');
  const marketPage = await source('src/app/market/page.tsx');

  assert.match(validator, /requireAdmin\(\)/);
  assert.match(validator, /repository\.origin.*api\/v1\/repos/);
  assert.doesNotMatch(validator, /git\.potemk\.in/);
  assert.match(validator, /saveDirectMarketApp/);
  assert.match(dialog, /router\.push\(data\.href\)/);
  assert.match(dialog, /addToMarket: true/);
  assert.match(await source('src/components/market/install-dialog.tsx'), /I trust this source and want to install it/);
  assert.match(catalog, /listDirectMarketAppViews/);
  assert.match(detail, /getDirectMarketApp/);
  assert.match(marketPage, /section === 'added'/);
});

test('direct entries install through the normal engine and remain removable only when uninstalled', async () => {
  const install = await source('src/app/api/market/install/route.ts');
  const remove = await source('src/app/api/market/direct/[sourceId]/route.ts');
  const detailPage = await source('src/app/market/[appId]/page.tsx');

  assert.match(install, /getDirectMarketApp/);
  assert.match(install, /acceptUnverifiedPublisher !== true/);
  assert.match(install, /updateInstalledAppSource\(config\.appId, 'url'/);
  assert.match(remove, /Uninstall this app before removing it from Market/);
  assert.match(detailPage, /Remove from Market/);
  assert.match(await source('src/app/api/market/app/[appId]/source/route.ts'), /getDirectMarketApp/);
  assert.doesNotMatch(detailPage, /app\.integration === 'native' \? 'YouEye \(official\)'/);
});

test('Market preflight precedes app-network mutation and core LXD keeps mandatory signatures', async () => {
  const engine = await source('src/lib/market/engine.ts');
  const deployer = await source('src/lib/infrastructure/lxd-deployer.ts');
  const stage = engine.indexOf('stageMarketNativeArtifacts(manifest, config,');
  const mutate = engine.indexOf('createAppNetwork(appId');
  assert.ok(stage >= 0 && mutate > stage, 'native artifact staging must happen before app network creation');
  assert.match(deployer, /export async function deployMarketLXDContainer/);
  assert.match(deployer, /signedReleaseVerificationShell\(releaseURL/);
  assert.doesNotMatch(deployer, /skipVerification/);
});
