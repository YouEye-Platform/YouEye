import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

// Exercise the actual self-contained route builder without loading live services.
function build() {
  const source = readFileSync(path.join(import.meta.dirname, '../src/lib/caddy/client.ts'), 'utf8');
  const tree = ts.createSourceFile('client.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = tree.statements.find((statement) => ts.isFunctionDeclaration(statement)
    && statement.name?.text === 'buildForwardAuthHandler');
  assert.ok(declaration);
  const code = ts.transpileModule(declaration.getText(tree), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  new Function('exports', code)(exports);
  return exports.buildForwardAuthHandler('127.0.0.1:3000', '/forward-auth/caddy', ['X-YouEye-Uid']);
}

for (const admitted of [true, false]) {
  test(`WebSocket authorization remains ordinary HTTP for ${admitted ? 'admitted' : 'denied'} callers`, async () => {
    let upgrades = 0;
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/forward-auth/caddy');
      assert.equal(req.headers.upgrade, undefined);
      for (const name of ['rsc', 'next-router-state-tree', 'next-router-prefetch',
        'next-router-segment-prefetch', 'next-url', 'next-action']) assert.equal(req.headers[name], undefined);
      assert.equal(req.headers.cookie, admitted ? 'fixture=allowed' : 'fixture=denied');
      res.writeHead(req.headers.cookie === 'fixture=allowed' ? 204 : 403,
        admitted ? { 'X-YouEye-Uid': 'validated-fixture-user' } : {});
      res.end();
    });
    server.on('upgrade', (_req, socket) => { upgrades += 1; socket.destroy(); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const original = { connection: 'Upgrade', upgrade: 'websocket',
        cookie: admitted ? 'fixture=allowed' : 'fixture=denied',
        rsc: '1', 'next-router-state-tree': 'encoded-app-router-tree', 'next-router-prefetch': '1',
        'next-router-segment-prefetch': '/_tree', 'next-url': '/locations', 'next-action': 'app-action',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
      const handler = build();
      const copied: Record<string, string> = { ...original };
      for (const name of handler.headers.request.delete) delete copied[name.toLowerCase()];
      const address = server.address(); assert.ok(address && typeof address !== 'string');
      const response = await new Promise<{ status: number; user: unknown }>((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port: address.port,
          method: handler.rewrite.method, path: handler.rewrite.uri, headers: copied }, (res) => {
          res.resume(); res.on('end', () => resolve({ status: res.statusCode!, user: res.headers['x-youeye-uid'] }));
        });
        request.on('error', reject); request.end();
      });
      assert.equal(response.status, admitted ? 204 : 403);
      assert.equal(response.user, admitted ? 'validated-fixture-user' : undefined);
      assert.equal(upgrades, 0);
      // Caddy's upstream-header operations affect its subrequest copy only.
      assert.equal(original.connection, 'Upgrade');
      assert.equal(original.upgrade, 'websocket');
      assert.equal(original['sec-websocket-key'], 'dGhlIHNhbXBsZSBub25jZQ==');
      assert.equal(original.rsc, '1');
      assert.equal(original['next-url'], '/locations');
      assert.equal(original['next-router-state-tree'], 'encoded-app-router-tree');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
}

test('authorization retains original routing context and strips supplied identity before copying validated identity', () => {
  const handler = build();
  assert.deepEqual(handler.handle_response[0].match.status_code, [2]);
  assert.equal(handler.headers.request.set['X-Forwarded-Method'][0], '{http.request.method}');
  assert.equal(handler.headers.request.set['X-Forwarded-Uri'][0], '{http.request.uri}');
  assert.equal(handler.headers.request.set['X-Forwarded-Host'][0], '{http.request.host}');
  const routes = handler.handle_response[0].routes;
  assert.deepEqual(routes[1].handle[0].request.delete, ['X-Youeye-Uid']);
  assert.equal(routes[2].handle[0].request.set['X-Youeye-Uid'][0], '{http.reverse_proxy.header.X-Youeye-Uid}');
});
