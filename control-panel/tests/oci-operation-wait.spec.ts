import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { classifyIncusOperationStatus } from '../src/lib/infrastructure/oci-deployer';

const root = process.env.CONTROL_PANEL_ROOT || path.join(import.meta.dirname, '..');

test('Incus operation waits accept only explicit terminal success', () => {
  assert.equal(classifyIncusOperationStatus({ status: 'Success' }), 'success');
  assert.equal(classifyIncusOperationStatus({ status: 'Running' }), 'pending');
  assert.equal(classifyIncusOperationStatus({ status: 'Pending' }), 'pending');
  assert.equal(classifyIncusOperationStatus(undefined), 'pending');
});

test('Incus operation waits fail closed on terminal failure states', () => {
  assert.equal(classifyIncusOperationStatus({ status: 'Failure' }), 'failure');
  assert.equal(classifyIncusOperationStatus({ status: 'Cancelled' }), 'failure');
  assert.equal(classifyIncusOperationStatus({ status: 'Canceled' }), 'failure');
});

test('large OCI imports use bounded polling with a thirty-minute deadline', () => {
  const source = readFileSync(
    path.join(root, 'src/lib/infrastructure/oci-deployer.ts'),
    'utf8',
  );
  assert.match(source, /Math\.min\(30, remainingSeconds\)/);
  assert.match(source, /classifyIncusOperationStatus\(meta\)/);
  assert.match(source, /waitForIncusOperation\(result\.operation, 1800\)/);
  assert.doesNotMatch(source, /waitForIncusOperation\(result\.operation, 600\)/);
});
