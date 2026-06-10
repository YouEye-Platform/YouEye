import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const cpRoot = process.env.CP_ROOT || join(import.meta.dirname, '..');

function read(path) {
  return readFileSync(join(cpRoot, path), 'utf8');
}

test('post-install identity integrations repair the app identity gateway proxy before setup', () => {
  const runner = read('src/lib/market/integration-runner.ts');

  assert.match(runner, /addSystemProxyDevices/);
  assert.match(runner, /getSystemServices/);
  assert.match(runner, /ensureIdentityGatewayProxy/);
  assert.match(runner, /needsSSO: true/);
  assert.match(runner, /integration\.type === 'identity' \|\| integration\.sso/);
  assert.match(runner, /buildCanonicalContext\(contextManifest, config, undefined, secrets\.db_password, undefined, true\)/);
});

test('LXD updater repairs Caddy root CA trust before no-op update exits', () => {
  const updater = read('src/lib/apps/lxd-updater.ts');

  assert.match(updater, /injectCaddyRootCA/);
  assert.match(updater, /Caddy root CA trusted in \$\{containerName\}/);
  assert.match(updater, /systemctl restart \$\{serviceName\}/);
  assert.ok(updater.indexOf('await injectCaddyRootCA(containerName)') < updater.indexOf('if (currentVersion === release.version'));
});
