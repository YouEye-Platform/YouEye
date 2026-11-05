import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.env.CONTROL_PANEL_ROOT || process.cwd();
const source = (path: string) => readFileSync(join(root, path), 'utf8');

test('Caddy sorting preserves security middleware and global ping before host routes', () => {
  const caddy = source('src/lib/caddy/client.ts');
  assert.match(caddy, /route\['@id'\] === 'security-header-strip' \? 0/);
  assert.match(caddy, /route\['@id'\] === 'api-ping-route' \? 1/);
  assert.match(caddy, /const rankDifference = rank\(a\) - rank\(b\)/);
});

test('setup reachability handshake is bound to the configured origin and exact iframe', () => {
  const parent = source('src/components/setup/SetupDnsExplainer.tsx');
  const ping = source('src/app/api/ping/route.ts');
  assert.match(parent, /event\.origin === expectedOrigin/);
  assert.match(parent, /event\.source === iframeRef\.current\?\.contentWindow/);
  assert.match(ping, /new URL\(document\.referrer\)\.origin/);
  assert.match(ping, /target!=="null"/);
  assert.match(ping, /postMessage\(\{type:"ye-dns-ok"\},target\)/);
  assert.doesNotMatch(ping, /postMessage\(\{type:"ye-dns-ok"\},"\*"\)/);
});
