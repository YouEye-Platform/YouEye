import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { buildTrustBundle } from '../src/lib/market/caddy-ca';

test('complete app trust bundle retains public roots and adds the YouEye root', () => {
  const systemBundle = readFileSync('/etc/ssl/certs/ca-certificates.crt', 'utf8');
  const certificate = systemBundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)?.[0];
  assert.ok(certificate);
  const originalCount = systemBundle.match(/BEGIN CERTIFICATE/g)?.length || 0;
  const bundle = buildTrustBundle(systemBundle, certificate);
  assert.equal(bundle.match(/BEGIN CERTIFICATE/g)?.length, originalCount + 1);
});

test('identity trust staging occurs before OCI deployment and health', () => {
  const source = readFileSync(new URL('../src/lib/market/engine.ts', import.meta.url), 'utf8');
  const stage = source.indexOf('await stageCaddyTrustBundle(appId)');
  const deploy = source.indexOf('await deployOCIContainer', stage);
  const health = source.indexOf('// Health check', deploy);
  assert.ok(stage >= 0 && stage < deploy && deploy < health);
  assert.match(source, /readOnly: true/);
  assert.match(source, /identityTrustBundle\.containerPath/);
});
