import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const repoRoot = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');
function read(path: string): string {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('B.2: authorize route renders the friendly identity error page, not raw JSON', () => {
  const authorize = read('src/app/application/o/authorize/route.ts');
  assert.match(authorize, /renderIdentityErrorPage/);
  // The three user-facing validation errors no longer return raw JSON.
  assert.doesNotMatch(authorize, /NextResponse\.json\(\{ error: 'invalid_redirect_uri' \}/);
  assert.doesNotMatch(authorize, /NextResponse\.json\(\{ error: 'invalid_client' \}/);
  assert.doesNotMatch(authorize, /NextResponse\.json\(\{ error: 'unsupported_response_type' \}/);
});

test('B.2: error page module has human copy, dark mode, and token colors', () => {
  const ep = read('src/lib/identity/error-page.ts');
  assert.match(ep, /That sign-in link didn’t work/);
  assert.match(ep, /prefers-color-scheme: dark/);
  assert.match(ep, /--accent:\s*#2563eb/);
  assert.match(ep, /<details>/);
});

test('B.2: machine OAuth endpoints keep JSON errors (token + userinfo unchanged)', () => {
  // OAuth2 requires JSON error bodies on these endpoints — they must NOT become HTML.
  assert.match(read('src/app/application/o/token/route.ts'), /NextResponse\.json\(\{ error:/);
  assert.match(read('src/app/application/o/userinfo/route.ts'), /NextResponse\.json\(\{ error:/);
});

test('A: globals.css reconciles --primary to the blue accent (CP + UI)', () => {
  assert.match(read('src/app/globals.css'), /--primary:\s*#2563eb/);
  // UI lives in the sibling package within the monorepo.
  const ui = readFileSync(join(repoRoot, '..', 'ui', 'src', 'app', 'globals.css'), 'utf8');
  assert.match(ui, /--primary:\s*#2563eb/);
});

test('B.3/B.4: identity login + consent use shared tokens + dark mode (no Inter, no hardcoded blue)', () => {
  const login = read('src/app/identity/login/route.ts');
  const consent = read('src/app/application/o/authorize/route.ts');
  for (const src of [login, consent]) {
    assert.match(src, /prefers-color-scheme: dark/);
    assert.match(src, /--accent: #2563eb/);
    assert.match(src, /"Geist Sans"/);
    assert.doesNotMatch(src, /font-family: Inter,/);
    assert.doesNotMatch(src, /#0b84ff/);
  }
  // login gets the "your account on this server" footer; consent keeps runtime switches.
  assert.match(login, /your account on this server/);
  assert.match(consent, /class="switch"/);
});
