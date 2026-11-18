import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.UI_ROOT || process.cwd();

describe('retired Market routes', () => {
  it('lets old app-market/app-store paths fall through to not-found without redirects', () => {
    const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8');

    assert.match(middleware, /RETIRED_PUBLIC_404_ROUTES[\s\S]*"\/app-market"/);
    assert.match(middleware, /RETIRED_PUBLIC_404_ROUTES[\s\S]*"\/app-store"/);
    assert.match(middleware, /RETIRED_PUBLIC_404_ROUTES\.some[\s\S]*NextResponse\.next\(\)/);
    assert.equal(existsSync(join(root, 'src/app/app-market/page.tsx')), false);
    assert.equal(existsSync(join(root, 'src/app/app-store/page.tsx')), false);
  });

  it('has no Market picture route and does not list one as public', () => {
    const middleware = readFileSync(join(root, 'src/middleware.ts'), 'utf8');
    assert.doesNotMatch(middleware, /market-image|\/api\/market\//);
    for (const route of ['src/app/api/market-image', 'src/app/api/market/image', 'src/app/api/market']) {
      assert.equal(existsSync(join(root, route)), false, route);
    }
  });
});
