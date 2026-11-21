import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { withoutDroppedWants, type Suggestion } from '../src/lib/bridges/suggestions';

const suggestion = (from: string, to: string): Suggestion => ({
  id: `bridge-${from}-${to}`, type: 'bridge', fromAppId: from, fromAppName: from,
  targetAppId: to, targetAppName: to, targetInstalled: false, scope: 'user', dismissed: false,
  createdAt: '2026-11-21T00:00:00Z',
});

test('an update that drops a connection drops its suggestion and nobody else\'s', () => {
  const stored = [suggestion('translate', 'libretranslate'), suggestion('translate', 'ollama'), suggestion('notes', 'libretranslate')];
  const kept = withoutDroppedWants(stored, 'translate', [{ appId: 'ollama', name: 'Ollama' }], () => undefined);
  assert.deepEqual(kept.map((s) => s.id), ['bridge-translate-ollama', 'bridge-notes-libretranslate']);
  assert.deepEqual(withoutDroppedWants(stored, 'translate', [], () => undefined).map((s) => s.id), ['bridge-notes-libretranslate']);
});

test('a suggestion made for a wanted capability stays while its target still provides it', () => {
  const stored = [suggestion('chat', 'ollama'), suggestion('chat', 'memos')];
  const provides = (id: string) => (id === 'ollama' ? [{ type: 'llm' }] : undefined);
  const kept = withoutDroppedWants(stored, 'chat', [{ type: 'llm', name: 'A language model' }] as never, provides as never);
  assert.deepEqual(kept.map((s) => s.id), ['bridge-chat-ollama']);
});

test('the update records the new release\'s wants and provides and refreshes the suggestions', () => {
  const updater = readFileSync(new URL('../src/lib/market/updater.ts', import.meta.url), 'utf8');
  assert.match(updater, /installMeta\.wants = manifest\.wants\?\.length \? manifest\.wants : undefined;/);
  assert.match(updater, /installMeta\.provides = manifest\.provides\?\.length \? manifest\.provides : undefined;/);
  assert.match(updater, /refreshSuggestionsForUpdatedApp\(manifest\)/);
});

test('the reverse scan reads what is installed now, and the start drops what apps no longer ask for', () => {
  const source = readFileSync(new URL('../src/lib/bridges/suggestions.ts', import.meta.url), 'utf8');
  const wants = source.slice(source.indexOf('async function installedWants'), source.indexOf('async function installedProvides'));
  assert.ok(wants.indexOf('readInstalledAppManifest') < wants.indexOf('meta.wants'), 'the frozen copy is read before the install metadata');
  assert.match(readFileSync(new URL('../src/instrumentation.ts', import.meta.url), 'utf8'), /dropSuggestionsOfDroppedWants\(\)/);
});

/** suggestions.ts over an in-memory store and the given installed apps (`frozen`: the installed copies; a missing one cannot be read). */
function loadSuggestions(stored: Suggestion[], installed: Array<Record<string, unknown>>, frozen: Record<string, Record<string, unknown>>) {
  const files = new Map<string, string>([['/var/lib/youeye/bridges/suggestions.json', JSON.stringify(stored)]]);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 2));
  const mocks: Record<string, unknown> = {
    'fs/promises': {
      async readFile(file: string) { await tick(); const raw = files.get(file); if (raw === undefined) throw new Error('ENOENT'); return raw; },
      async mkdir() {},
    },
    path: path,
    '../market/metadata': { listReadableInstalledApps: async () => installed },
    '../market/frozen-manifest': { readInstalledAppManifest: async (id: string) => { await tick(); if (!frozen[id]) throw new Error('unreadable'); return frozen[id]; } },
    '../health/notification-bridge': { sendNotificationToUI: async () => {} },
    './store': { loadBridges: async () => [] },
    './atomic-json-store': { async writeJsonAtomically(file: string, value: unknown) { await tick(); files.set(file, JSON.stringify(value)); } },
  };
  const exports: Record<string, any> = {};
  const source = readFileSync(new URL('../src/lib/bridges/suggestions.ts', import.meta.url), 'utf8');
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, { exports, console, setTimeout, Symbol, globalThis: {}, require(name: string) {
    if (name in mocks) return mocks[name];
    throw new Error(`Unexpected import: ${name}`);
  } });
  const read = () => (JSON.parse(files.get('/var/lib/youeye/bridges/suggestions.json')!) as Suggestion[]);
  return { suggestions: exports, read };
}

// The cleanup at start judged a wanted capability against the target's install metadata, which still names what the
// release it was installed from provided: Ollama gained "llm" in an update, and the suggestion for it was dropped.
test('the cleanup at start reads what a target provides from its installed copy', async () => {
  const stored = [suggestion('chat', 'ollama'), suggestion('chat', 'memos'), suggestion('chat', 'notes')];
  const installed = [
    { appId: 'chat', wants: [] },
    { appId: 'ollama', provides: [] }, // the metadata of the release it was installed from
    { appId: 'memos', provides: [] },
    { appId: 'notes', provides: [{ type: 'llm' }] }, // provided it once; the installed release does not
  ];
  const { suggestions, read } = loadSuggestions(stored, installed, {
    chat: { wants: [{ type: 'llm', name: 'A language model' }] },
    ollama: { provides: [{ type: 'llm' }] },
    notes: { provides: [] },
    // memos: its installed copy cannot be read
  });
  assert.equal(await suggestions.dropSuggestionsOfDroppedWants(), 1);
  assert.deepEqual(read().map((s) => s.id), ['bridge-chat-ollama', 'bridge-chat-memos'],
    'the target that provides it now stays, the unreadable one stays, the one that stopped providing it goes');
});

test('a target whose provides cannot be told keeps a suggestion made for a capability, not one for a dropped app', () => {
  const stored = [suggestion('chat', 'ollama'), suggestion('chat', 'memos')];
  const kept = withoutDroppedWants(stored, 'chat', [{ type: 'llm', name: 'A language model' }] as never, () => null);
  assert.deepEqual(kept.map((s) => s.id), ['bridge-chat-ollama', 'bridge-chat-memos']);
  assert.deepEqual(withoutDroppedWants(stored, 'chat', [{ appId: 'ollama', name: 'Ollama' }], () => null).map((s) => s.id), ['bridge-chat-ollama']);
});

// Every change of the store is a read, an edit and a write. The cleanup at start ran beside a dismissal or an
// install's suggestions with no lock, and whoever wrote last undid the other.
test('changes of the suggestion store do not undo each other', async () => {
  const stored = [suggestion('translate', 'libretranslate'), suggestion('chat', 'ollama'), suggestion('notes', 'ollama')];
  const installed = [{ appId: 'translate' }, { appId: 'chat' }, { appId: 'notes' }, { appId: 'ollama' }];
  const { suggestions, read } = loadSuggestions(stored, installed, {
    translate: { wants: [] }, // dropped LibreTranslate
    chat: { wants: [{ appId: 'ollama', name: 'Ollama' }] },
    notes: { wants: [{ appId: 'ollama', name: 'Ollama' }] },
    ollama: {},
  });
  const [dropped] = await Promise.all([
    suggestions.dropSuggestionsOfDroppedWants(),
    suggestions.dismissSuggestion('bridge-chat-ollama'),
    suggestions.removeSuggestion('bridge-notes-ollama'),
  ]);
  assert.equal(dropped, 1);
  assert.deepEqual(read().map((s) => [s.id, s.dismissed]), [['bridge-chat-ollama', true]]);
});
