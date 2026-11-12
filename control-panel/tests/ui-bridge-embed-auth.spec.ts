import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { embedBridgeDecision } from '../src/lib/ui-bridge/embed-decision';

const admin = { isAdmin: true, authMethod: 'sso' };
const member = { isAdmin: false, authMethod: 'sso' };

test('embed bridge calls need a signed-in session', () => {
  for (const method of ['GET', 'POST']) {
    assert.deepEqual(embedBridgeDecision({ method, session: null, csrfValid: true }), { status: 401, error: 'Sign in required' });
  }
});

test('embed bridge calls are admin-only, reads included', () => {
  assert.equal(embedBridgeDecision({ method: 'GET', session: member, csrfValid: true })?.status, 403);
  assert.equal(embedBridgeDecision({ method: 'DELETE', session: member, csrfValid: true })?.status, 403);
  assert.equal(embedBridgeDecision({ method: 'GET', session: { isAdmin: true, authMethod: 'setup' }, csrfValid: true })?.status, 403);
});

test('an admin reads without CSRF but changes state only with it', () => {
  assert.equal(embedBridgeDecision({ method: 'GET', session: admin, csrfValid: false }), null);
  assert.equal(embedBridgeDecision({ method: 'head', session: admin, csrfValid: false }), null);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post']) {
    assert.deepEqual(embedBridgeDecision({ method, session: admin, csrfValid: false }), { status: 403, error: 'Invalid CSRF token' });
    assert.equal(embedBridgeDecision({ method, session: admin, csrfValid: true }), null);
  }
});

test('every CP /api/ui-bridge route handler checks requireEmbedAdmin first, and the middleware does not make them public', () => {
  const root = path.join(process.env.CONTROL_PANEL_ROOT ?? process.cwd(), 'src/app/api/ui-bridge');
  const routes: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry === 'route.ts') routes.push(full);
    }
  };
  walk(root);
  assert.ok(routes.length > 0);
  for (const route of routes) {
    const source = readFileSync(route, 'utf8');
    const handlers = [...source.matchAll(/export async function (GET|POST|PUT|PATCH|DELETE)\([^)]*\)[^{]*\{\s*([^\n]*)/g)];
    assert.ok(handlers.length > 0, route);
    for (const [, method, firstLine] of handlers) {
      assert.match(firstLine, /requireEmbedAdmin\(request\)/, `${path.relative(root, route)} ${method}`);
    }
  }
  const middleware = readFileSync(path.join(root, '../../../middleware.ts'), 'utf8');
  assert.doesNotMatch(middleware, /'\/api\/ui-bridge'/);
});

test('embed pages send the CSRF token with their calls', () => {
  const root = path.join(process.env.CONTROL_PANEL_ROOT ?? process.cwd(), 'src/app/embed');
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : entry.endsWith('.tsx') ? [full] : [];
  });
  for (const file of walk(root)) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /(?<![A-Za-z.])fetch\(["`]\/api/, path.relative(root, file));
  }
});
