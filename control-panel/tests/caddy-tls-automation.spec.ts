import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  generateInitialConfig,
  loadExternalCert,
  removeExternalCert,
  setDomain,
} from '../src/lib/caddy/client';
import type { CaddyConfig } from '../src/lib/caddy/types';

function fixtureConfig(): CaddyConfig {
  return {
    admin: { listen: '0.0.0.0:2019', enforce_origin: false },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443'],
            routes: [],
            tls_connection_policies: [{}],
          },
        },
      },
      tls: {
        automation: {
          policies: [{ on_demand: true, issuers: [{ module: 'internal' }] }],
          on_demand: {
            permission: {
              module: 'http',
              endpoint: 'http://youeye-control.internal:3000/api/setup/config',
            },
          },
        },
      },
    },
  };
}

async function withCaddyFixture(
  initial: CaddyConfig,
  run: (lastConfig: () => CaddyConfig) => Promise<void>,
): Promise<void> {
  let config = structuredClone(initial);
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/config/') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(config));
      return;
    }
    if (req.method === 'POST' && req.url === '/load') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        config = JSON.parse(body) as CaddyConfig;
        res.statusCode = 200;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previous = process.env.CADDY_ADMIN_URL;
  process.env.CADDY_ADMIN_URL = `http://127.0.0.1:${address.port}`;
  try {
    await run(() => structuredClone(config));
  } finally {
    if (previous === undefined) delete process.env.CADDY_ADMIN_URL;
    else process.env.CADDY_ADMIN_URL = previous;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('known internal TLS subjects are selected for certificate automation', async () => {
  const initial = generateInitialConfig(['devvm.test', '*.devvm.test']);
  assert.deepEqual(
    initial.apps?.tls?.certificates?.automate,
    ['devvm.test', '*.devvm.test'],
  );

  await withCaddyFixture(fixtureConfig(), async (lastConfig) => {
    await setDomain('devvm.test');
    const loaded = lastConfig();
    assert.deepEqual(
      loaded.apps?.tls?.automation?.policies?.[0]?.subjects,
      ['devvm.test', '*.devvm.test'],
    );
    assert.deepEqual(
      loaded.apps?.tls?.certificates?.automate,
      ['devvm.test', '*.devvm.test'],
    );
  });
});

test('external certificates disable duplicate automation and restore it on removal', async () => {
  const initial = fixtureConfig();
  initial.apps!.tls!.automation!.policies!.unshift({
    subjects: ['devvm.test', '*.devvm.test'],
    issuers: [{ module: 'internal' }],
  });
  initial.apps!.tls!.certificates = {
    automate: ['devvm.test', '*.devvm.test'],
  };

  await withCaddyFixture(initial, async (lastConfig) => {
    await loadExternalCert('test-certificate', 'test-private-key', ['devvm.test', '*.devvm.test']);
    assert.deepEqual(lastConfig().apps?.tls?.certificates?.automate, []);

    await removeExternalCert();
    const restored = lastConfig();
    assert.deepEqual(
      restored.apps?.tls?.certificates?.automate,
      ['devvm.test', '*.devvm.test'],
    );
    assert.ok(restored.apps?.tls?.automation?.policies?.some(
      (policy) => policy.issuers?.some((issuer) => issuer.module === 'internal')
        && policy.subjects?.includes('devvm.test'),
    ));
  });
});
