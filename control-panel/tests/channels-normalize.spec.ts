import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReleaseChannels } from '../src/lib/updates/channels';

// release_channels arrives in two shapes: the yaml shape (local-file fallback)
// and the Spine API view ({effective, override} with flat "app:<id>" keys).
// Regression: CP read the API shape as if it were the yaml shape, saw no
// overrides, and resolved every channel to main (ui updates ignored the
// selected branch on the live box).

test('normalize: yaml shape passes through', () => {
  const yamlShape = {
    default: { branch: 'main', fallback: ['main'] },
    spine: { branch: 'f-x', fallback: [] },
    apps: { wiki: { branch: 'f-drawer' } },
  };
  assert.deepEqual(normalizeReleaseChannels(yamlShape), yamlShape);
});

test('normalize: spine API view uses the raw override map, folds app keys', () => {
  const apiShape = {
    effective: {
      default: { source: 's', branch: 'main', fallback: ['main'] },
      spine: { source: 's', branch: 'f-x', fallback: [] },
      ui: { source: 's', branch: 'f-verchan', fallback: ['main'] },
      'app:wiki': { source: 's', branch: 'f-drawer', fallback: ['main'] },
    },
    override: {
      spine: { branch: 'f-x', fallback: [] },
      ui: { branch: 'f-verchan' },
      'app:wiki': { branch: 'f-drawer' },
    },
  };
  assert.deepEqual(normalizeReleaseChannels(apiShape), {
    spine: { branch: 'f-x', fallback: [] },
    ui: { branch: 'f-verchan' },
    apps: { wiki: { branch: 'f-drawer' } },
  });
});

test('normalize: API view with empty override yields empty config', () => {
  assert.deepEqual(normalizeReleaseChannels({ effective: {}, override: {} }), {});
});

test('normalize: non-objects yield null', () => {
  assert.equal(normalizeReleaseChannels(undefined), null);
  assert.equal(normalizeReleaseChannels('main'), null);
  assert.equal(normalizeReleaseChannels(null), null);
});

// ── App source precedence (regression: wiki channel resolved against Market) ──
// effectiveChannel must base a native app on ITS OWN repo (appDefaultSource),
// even when the default channel has an explicit source (the core repo can
// never serve bare-tag app releases), and an explicit app override wins.
import { effectiveChannel } from '../src/lib/updates/channels';

test('app channel bases on the app repo even with an explicit default source', async () => {
  const ch = await effectiveChannel('app:wiki', {
    config: { default: { source: 'https://forgejo.example.test/potemsla/YouEye', branch: 'main' } },
    appDefaultSource: 'https://forgejo.example.test/potemsla/YE-App-Wiki',
  });
  assert.equal(ch.source, 'https://forgejo.example.test/potemsla/YE-App-Wiki');
  assert.equal(ch.branch, 'main');
});

test('explicit app channel source + branch override the app-repo base', async () => {
  const ch = await effectiveChannel('app:wiki', {
    config: {
      apps: { wiki: { source: 'https://forgejo.example.test/potemsla/YE-App-Wiki', branch: 'f-verchan', fallback: ['main'] } },
    },
    appDefaultSource: 'https://example.com/market',
  });
  assert.equal(ch.source, 'https://forgejo.example.test/potemsla/YE-App-Wiki');
  assert.equal(ch.branch, 'f-verchan');
  assert.deepEqual(ch.fallback, ['main']);
});
