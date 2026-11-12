import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const cpRoot = process.env.CP_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(cpRoot, path), 'utf8');
}

test('LXD updater creates rollback state before trust repair or no-op restart', () => {
  const updater = read('src/lib/apps/lxd-updater.ts');

  assert.match(updater, /injectCaddyRootCA/);
  assert.match(updater, /Caddy root CA trusted in \$\{containerName\}/);
  assert.match(updater, /systemctl start \$\{serviceName\}/);
  assert.ok(updater.indexOf('await createSnapshot(containerName, SNAPSHOT_NAME)') < updater.indexOf('await injectCaddyRootCA(containerName)'));
});
