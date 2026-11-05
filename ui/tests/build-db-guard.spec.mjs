import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), 'utf8');

test('schema initialization skips Next production build and throws runtime failures', () => {
  const source = read('src/db/index.ts');
  assert.match(source, /isNextProductionBuild/);
  assert.match(source, /if \(isNextProductionBuild\(\)\) return;/);
  assert.match(source, /console\.error\("Schema initialization failed:", e\);[\s\S]*throw e;/);
});

test('branding metadata helpers use build-time defaults instead of probing Postgres', () => {
  const branding = read('src/lib/db/queries/branding.ts');
  const siteConfig = read('src/lib/site-config.ts');
  assert.match(branding, /if \(isNextProductionBuild\(\)\) \{[\s\S]*return getDefaultBranding\(\);[\s\S]*\}/);
  assert.match(siteConfig, /if \(isNextProductionBuild\(\)\) \{[\s\S]*return DEFAULT_SITE_NAME;[\s\S]*\}/);
});
