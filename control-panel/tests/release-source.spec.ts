import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { OFFICIAL_RELEASE_REPOSITORY, isSameRepository, repositoryAddress } from '../src/lib/releases/release-source';
import { englishInterfaceSource } from './helpers/localized-source.mjs';

// YE-130: Settings → System can switch the repository the box follows (owner, 2026-11-23). Spine checks the target
// (systemupdate.SetReleaseSource); the route lets only admins ask, and the form suggests no host but the official one.
const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function load(path: string, dependencies: Record<string, unknown>): Record<string, any> {
  const output = ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: path,
  }).outputText;
  const exports = {};
  new Function('require', 'exports', output)((name: string) => {
    if (!(name in dependencies)) throw new Error(`Unexpected test dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}

class SpineAPIError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}

function fixture() {
  const state = {
    session: { isAdmin: true } as { isAdmin: boolean } | null,
    csrf: true,
    calls: [] as unknown[][],
    answer: async (channel: string, repository?: string): Promise<Record<string, unknown>> =>
      ({ channel, repository: repository ?? OFFICIAL_RELEASE_REPOSITORY, ...(repository ? { head_version: '0.6.16' } : {}) }),
  };
  const route = load('src/app/api/releases/channel/route.ts', {
    'next/server': { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
    '@/lib/auth': { getSession: async () => state.session, verifyCSRFToken: async (token: string) => state.csrf && token === 'csrf' },
    '@/lib/spine/client': {
      SpineAPIError,
      spineClient: {
        getReleaseChannel: async () => ({ channel: 'stable', repository: OFFICIAL_RELEASE_REPOSITORY }),
        setReleaseChannel: async (...args: [string, string?]) => { state.calls.push(args); return state.answer(...args); },
      },
    },
    '@/lib/releases/channel-index': { isReleaseChannel: (value: unknown) => ['dev', 'alpha', 'beta', 'stable'].includes(value as string) },
  });
  const put = async (body: unknown, token = 'csrf') => {
    const response: Response = await route.PUT(new Request('http://control/api/releases/channel', {
      method: 'PUT', headers: { 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { state, route, put };
}

test('only an admin with a CSRF token may read or change the release source', async () => {
  const { state, route, put } = fixture();
  state.session = { isAdmin: false };
  assert.equal((await route.GET()).status, 403);
  assert.equal((await put({ channel: 'alpha', repository: 'https://forge.example.org/team/YouEye' })).status, 403);
  state.session = null;
  assert.equal((await put({ channel: 'alpha' })).status, 403);
  state.session = { isAdmin: true };
  assert.equal((await put({ channel: 'alpha', repository: 'https://forge.example.org/team/YouEye' }, 'wrong')).status, 403);
  assert.deepEqual(state.calls, []);
});

test('the route passes a channel, or a channel and a repository, to Spine and nothing else', async () => {
  const { state, put } = fixture();
  assert.deepEqual(await put({ channel: 'beta' }), { status: 200, body: { channel: 'beta', repository: OFFICIAL_RELEASE_REPOSITORY } });
  const switched = await put({ repository: 'https://forge.example.org/team/YouEye', channel: 'alpha' });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.head_version, '0.6.16');
  assert.deepEqual(state.calls, [['beta', undefined], ['alpha', 'https://forge.example.org/team/YouEye']]);
  for (const bad of [{ channel: 'main' }, { channel: 'beta', source: 'x' }, { channel: 'beta', repository: 7 }, { channel: 'beta', repository: '' },
    { channel: 'beta', repository: `https://forge.example.org/${'x'.repeat(2100)}/YouEye` }, 'not json']) {
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal(state.calls.length, 2);
});

test("Spine's refusal reaches the form with its status and reason", async () => {
  const { state, put } = fixture();
  state.answer = async () => { throw new SpineAPIError('release source refused: the alpha channel index of https://forge.example.org/team/YouEye names another repository', 422); };
  assert.deepEqual(await put({ channel: 'alpha', repository: 'https://forge.example.org/team/YouEye' }), {
    status: 422, body: { error: 'release source refused: the alpha channel index of https://forge.example.org/team/YouEye names another repository' },
  });
  state.answer = async () => { throw new SpineAPIError('the repository can change only after the first deploy finished', 409); };
  assert.equal((await put({ channel: 'alpha', repository: 'https://forge.example.org/team/YouEye' })).status, 409);
});

test('repository addresses are read like Spine reads them', () => {
  assert.equal(repositoryAddress(' https://GitHub.com/YouEye-Platform/YouEye.git/ '), OFFICIAL_RELEASE_REPOSITORY);
  assert.equal(repositoryAddress('https://forge.example.org:3000/team/You.Eye'), 'https://forge.example.org:3000/team/You.Eye');
  for (const bad of ['http://github.com/YouEye-Platform/YouEye', 'https://github.com/YouEye-Platform', 'https://u:p@github.com/a/b',
    'https://github.com/a/b/c', 'https://github.com/a/b?x=1', 'https://github.com/a./b', '']) {
    assert.equal(repositoryAddress(bad), null, bad);
  }
  assert.equal(isSameRepository('https://github.com/YouEye-Platform/YouEye/', OFFICIAL_RELEASE_REPOSITORY), true);
  assert.equal(isSameRepository('https://forge.example.org/team/YouEye', OFFICIAL_RELEASE_REPOSITORY), false);
  assert.equal(isSameRepository('not a url', OFFICIAL_RELEASE_REPOSITORY), false);
});

test('the form confirms a repository switch and suggests no host but the official one', () => {
  const form = englishInterfaceSource(readFileSync(join(root, 'src/components/settings-shell/release-channel.tsx'), 'utf8'));
  const english = JSON.parse(readFileSync(join(root, 'messages/en.json'), 'utf8')).settingsSystem.channel;
  assert.match(form, /OFFICIAL_RELEASE_REPOSITORY/);
  assert.match(form, /t\("channel\.confirm"/);
  assert.match(form, /confirming && <div/);
  assert.match(form, /repository: address/);
  assert.match(english.confirm, /never downgrades/);
  // The only address in the form, its strings and its helper is the official repository.
  const helper = readFileSync(join(root, 'src/lib/releases/release-source.ts'), 'utf8');
  const hosts = [...`${form}\n${JSON.stringify(english)}\n${helper}`.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]+)/gi)].map((m) => m[1].toLowerCase());
  assert.deepEqual([...new Set(hosts)].filter((host) => host !== 'github.com'), []);
  assert.doesNotMatch(form, /placeholder=/);
});
