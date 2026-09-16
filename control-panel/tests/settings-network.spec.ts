import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

// Source-regression checks for Plan 1 Workstream C2 — Network page (DNS / Routes / Domain & HTTPS).
// Run: CONTROL_PANEL_ROOT="$PWD" pnpm exec node --import tsx --test tests/settings-network.spec.ts
const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(repoRoot, p), 'utf8');
const has = (p: string) => existsSync(join(repoRoot, p));

test('Switch primitive exists, dependency-free, shadcn-compatible API', () => {
  assert.ok(has('src/components/ui/switch.tsx'), 'switch.tsx must exist');
  const sw = read('src/components/ui/switch.tsx');
  assert.match(sw, /role="switch"/);
  assert.match(sw, /onCheckedChange/);
  assert.match(sw, /aria-checked/);
  // No @radix dependency imported (the comment may mention it; an import must not exist).
  assert.doesNotMatch(sw, /from ["']@radix-ui\/react-switch["']/);
});

test('Network page has three tabs: DNS / Routes / Domain & HTTPS', () => {
  const c = read('src/components/settings-shell/network-client.tsx');
  assert.match(c, /"dns"\s*\|\s*"routes"\s*\|\s*"domain"/);
  assert.match(c, /label:\s*"DNS"/);
  assert.match(c, /label:\s*"Routes"/);
  assert.match(c, /label:\s*"Domain & HTTPS"/);
  // tab initial state derived synchronously (no flash — pitfall #21)
  assert.match(c, /useState<NetworkTab>\(\(\)\s*=>/);
});

test('DNS tab wires real Pi-Hole APIs incl. blocking switch, blocklists toggle, queries', () => {
  const c = read('src/components/settings-shell/network-client.tsx');
  assert.match(c, /\/api\/apps\/pihole\/stats/);
  assert.match(c, /\/api\/apps\/pihole\/lists/);
  assert.match(c, /\/api\/apps\/pihole\/dns-records/);
  assert.match(c, /\/api\/apps\/pihole\/cname-records/);
  assert.match(c, /\/api\/apps\/pihole\/queries\?limit=/);
  assert.match(c, /\/api\/apps\/pihole\/control/);
  // master blocking switch + per-blocklist switch use the Switch primitive
  assert.match(c, /from "@\/components\/ui\/switch"/);
  assert.match(c, /onCheckedChange=\{toggleBlocking\}/);
});

test('writes send CSRF via /settings/api/auth/csrf (CP admin pattern)', () => {
  const c = read('src/components/settings-shell/network-client.tsx');
  assert.match(c, /\/settings\/api\/auth\/csrf/);
  assert.match(c, /"X-CSRF-Token"/);
});

test('blocklists endpoint added (session-authed, GET/POST/PATCH/DELETE)', () => {
  assert.ok(has('src/app/api/apps/pihole/lists/route.ts'), 'apps/pihole/lists route must exist');
  const r = read('src/app/api/apps/pihole/lists/route.ts');
  assert.match(r, /export async function GET/);
  assert.match(r, /export async function POST/);
  assert.match(r, /export async function PATCH/);
  assert.match(r, /export async function DELETE/);
  assert.match(r, /piholeRequest/);
  // session auth (not the embed-gated bridge wrapper)
  assert.match(r, /getSession/);
  assert.doesNotMatch(r, /validateBridgeToken/);
});

test('Routes tab reaches Caddy via /settings/api/caddy/* proxies (root /api/caddy 404s from settings)', () => {
  assert.ok(has('src/app/settings/api/caddy/routes/route.ts'));
  assert.ok(has('src/app/settings/api/caddy/config/route.ts'));
  assert.match(read('src/app/settings/api/caddy/routes/route.ts'), /export \{ GET \} from "@\/app\/api\/caddy\/routes\/route"/);
  const c = read('src/components/settings-shell/network-client.tsx');
  assert.match(c, /\/settings\/api\/caddy\/routes/);
  assert.match(c, /\/settings\/api\/caddy\/config/);
});

test('Domain & HTTPS tab uses real domain + tls status; honest on-demand copy, no fake cert data', () => {
  const c = read('src/components/settings-shell/network-client.tsx');
  assert.match(c, /\/api\/domain/);
  assert.match(c, /\/api\/tls\/status/);
  // on-demand/internal TLS is presented honestly, not faked cert fields
  assert.match(c, /Private\/local certificate/);
});
