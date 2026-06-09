import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('app network creation requires Pi-Hole DNS forwarding', () => {
  const appNetwork = read('src/lib/incus/app-network.ts');
  const engine = read('src/lib/market/engine.ts');

  assert.match(appNetwork, /Cannot create app network: Pi-Hole IP was not found/);
  assert.match(appNetwork, /config\['raw\.dnsmasq'\] = `server=\$\{piholeIP\}`/);
  assert.doesNotMatch(appNetwork, /DNS forwarding will not work/);

  assert.match(engine, /Failed to create Pi-Hole-backed app network/);
  assert.match(engine, /await rollbackInstall\(rollbackCtx, onEvent, totalSteps\)/);
  assert.doesNotMatch(engine, /falling back to incusbr0/);
});
