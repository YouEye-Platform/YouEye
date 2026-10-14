import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { coreStartupHeld } from '../src/lib/updates/core-startup';

test('background writers remain held through missing, corrupt or insecure reservation contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'core-startup-'));
  const file = join(root, 'reservation.json');
  try {
    assert.equal(coreStartupHeld(file), false);
    writeFileSync(file, '{"schema":"youeye.core-lifecycle.v1","pid":-1,"old":true}', { mode: 0o600 });
    assert.equal(coreStartupHeld(file), true);
    writeFileSync(file, 'corrupt');
    assert.equal(coreStartupHeld(file), true);
    rmSync(file);
    symlinkSync('missing', file);
    assert.equal(coreStartupHeld(file), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
