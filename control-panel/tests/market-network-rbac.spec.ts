import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(process.cwd(), relativePath), 'utf8');
}

const adminMutationRoutes = [
  'src/app/api/market/install/route.ts',
  'src/app/api/market/install-url/route.ts',
  'src/app/api/market/uninstall/route.ts',
  'src/app/api/market/bundles/[id]/install/route.ts',
  'src/app/api/market/integrations/apply/route.ts',
  'src/app/api/market/integrations/remove/route.ts',
  'src/app/api/bridges/route.ts',
  'src/app/api/bridges/[bridgeId]/route.ts',
  'src/app/api/internet-grants/route.ts',
  'src/app/api/internet-grants/[id]/route.ts',
  'src/app/api/suggestions/route.ts',
  'src/app/api/suggestions/[id]/dismiss/route.ts',
  'src/app/api/suggestions/regenerate/route.ts',
];

test('Market and app-network mutations require an administrator session', async () => {
  for (const route of adminMutationRoutes) {
    const contents = await source(route);
    assert.match(contents, /import \{[^}]*requireAdmin[^}]*\} from '@\/lib\/auth\/rbac';/, route);
    assert.match(contents, /const auth = await requireAdmin\(\);\s*if \(auth\.error\) return auth\.error;/, route);
  }
});

test('middleware-public app-network reads still require an authenticated session', async () => {
  for (const route of [
    'src/app/api/bridges/route.ts',
    'src/app/api/bridges/[bridgeId]/route.ts',
    'src/app/api/bridges/resolve/route.ts',
    'src/app/api/internet-grants/route.ts',
    'src/app/api/suggestions/route.ts',
  ]) {
    const contents = await source(route);
    assert.match(contents, /import \{[^}]*requireAuth[^}]*\} from '@\/lib\/auth\/rbac';/, route);
    assert.match(contents, /const auth = await requireAuth\(\);\s*if \(auth\.error\) return auth\.error;/, route);
  }
});
