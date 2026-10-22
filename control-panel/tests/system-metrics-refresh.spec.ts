import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

test('System cards refresh without loading flashes, overlapping requests or timers after unmount', async () => {
  const effects: Array<() => (() => void) | void> = [];
  const timers = new Map<number, () => Promise<void>>();
  const changes: unknown[] = [];
  let sequence = 0, requests = 0, release: (() => void) | undefined;
  let slow = false, failed = false;
  const exports: any = {};
  const source = ts.transpileModule(readFileSync('src/components/settings-shell/system-client.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  runInNewContext(source, { exports, Error,
    setTimeout(callback: () => Promise<void>, delay: number) {
      assert.equal(delay, 15_000); timers.set(++sequence, callback); return sequence;
    },
    clearTimeout(id: number) { timers.delete(id); },
    setInterval() { return 1; }, clearInterval() {},
    async fetch(path: string) {
      if (path === '/settings/api/settings/system') {
        requests++;
        if (slow) await new Promise<void>(resolve => { release = resolve; });
        if (failed) throw new Error('test connection interrupted');
      }
      return { ok: true, async json() { return {}; } };
    },
    require(id: string) {
      if (id === 'react') return {
        useState(initial: unknown) { return [initial, (value: unknown) => changes.push(value)]; },
        useRef(value: unknown) { return { current: value }; },
        useCallback(fn: unknown) { return fn; },
        useEffect(fn: () => (() => void) | void) { effects.push(fn); },
      };
      if (id === 'react/jsx-runtime') return { jsx() { return null; }, jsxs() { return null; } };
      return new Proxy({}, { get(_target, name) { return String(name); } });
    },
  });
  exports.SystemClient({});
  const cleanup = effects.map(effect => effect());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(timers.size, 1, 'host cards must schedule a refresh after mounting');
  changes.length = 0;
  const tick = () => {
    const [id, callback] = timers.entries().next().value!;
    timers.delete(id); return callback();
  };
  slow = true;
  const pending = tick();
  assert.equal(requests, 2);
  assert.equal(timers.size, 0, 'no overlapping interval while request is pending');
  assert.ok(!changes.includes(true), 'background refresh must not enable page loading');
  release!(); await pending;
  assert.equal(timers.size, 1);
  slow = false; failed = true;
  await tick();
  assert.ok(changes.includes('test connection interrupted'));
  failed = false; changes.length = 0;
  await tick();
  assert.ok(changes.includes(''), 'next success clears the visible error');
  slow = true;
  const unmounting = tick();
  cleanup.forEach(stop => stop?.());
  release!(); await unmounting;
  assert.equal(timers.size, 0, 'completed request must not reschedule after unmount');
});
