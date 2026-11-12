import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Off loopback, Caddy's admin API accepts only Hosts in `origins`; `origins *` matches nothing, so every CP request
// (the first /load included) got 403 and a fresh install never finished its first deployment (0.6.3-dev.15).
test('every Caddyfile names the admin listen address as its only origin', () => {
  const source = readFileSync('src/lib/infrastructure/deployer.ts', 'utf8');
  assert.doesNotMatch(source, /origins \*/);
  const blocks = source.match(/admin \$\{adminAddress\} \{`,\n[^\n]*\n\s*`\s+origins \$\{adminAddress\}`/g) ?? [];
  assert.equal(blocks.length, 2, 'both Caddyfile templates pin origins to the admin address');
});
