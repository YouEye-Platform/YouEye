import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { controlPanelCaddyfile } from '../src/lib/caddy/caddyfile';

// Off loopback, Caddy's admin API accepts only Hosts in `origins`; `origins *` matches nothing, so every CP request
// (the first /load included) got 403 and a fresh install never finished its first deployment (0.6.3-dev.15).
test('the Caddyfile names the admin listen address as its only origin, and every deploy path uses it', () => {
  const caddyfile = controlPanelCaddyfile('10.45.18.13:2019', '10.45.18.16');
  assert.doesNotMatch(caddyfile, /origins \*/);
  assert.match(caddyfile, /admin 10\.45\.18\.13:2019 \{\n\s+origins 10\.45\.18\.13:2019\n\s+\}/);
  const deployer = readFileSync('src/lib/infrastructure/deployer.ts', 'utf8');
  assert.doesNotMatch(deployer, /origins/);
  assert.equal(deployer.match(/controlPanelCaddyfile\(adminAddress, controlIP\)/g)?.length, 2,
    'first deploy and the missing-Caddy repair both load the same Caddyfile');
});
