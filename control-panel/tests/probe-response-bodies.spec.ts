import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// YE-213: a probe that judges only the status lets go of the body at once. Left unread, the body kept its
// keep-alive connection paused, and when the app (or Caddy) restarted, Node's HTTP client threw an uncaught
// assertion in the Control Panel (`assert(!this.paused)`, undici Parser.finish on socket end).
const probes: Array<[string, RegExp]> = [
  ['src/lib/market/health.ts', /const resp = await fetch\(`http:\/\/\$\{ip\}:\$\{port\}\$\{path\}`/],
  ['src/lib/market/app-prober.ts', /const res = await fetch\(`http:\/\/\$\{ip\}:\$\{port\}\$\{path\}`/],
  ['src/lib/reconfigure/index.ts', /const res = await fetch\(`http:\/\/\$\{ip\}:\$\{primaryPort\}\/`/],
  ['src/lib/infrastructure/health-checks.ts', /const resp = await fetch\(`http:\/\/\$\{ip\}:2019\/config\/`/],
];

for (const [file, call] of probes) {
  test(`${file}: the status-only probe cancels its response body before judging the status`, () => {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const match = call.exec(source);
    assert.ok(match, 'the probe fetch is where it was');
    const after = source.slice(match.index, match.index + 600);
    const name = /const (\w+) = await fetch/.exec(match[0])![1];
    const cancel = after.indexOf(`await ${name}.body?.cancel()`);
    const judged = after.search(new RegExp(`if \\(\\(?${name}\\.(ok|status)`));
    assert.ok(cancel > 0, 'the body is cancelled');
    assert.ok(judged > cancel, 'before the status decides');
  });
}
