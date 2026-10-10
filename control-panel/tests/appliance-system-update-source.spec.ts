import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSystemUpdateSelection,
  normalizeSystemUpdateSelection,
} from '../src/lib/appliance/system-update-source';
import type { SpineRuntimeStatus } from '../src/lib/spine/client';

const root = process.env.CONTROL_PANEL_ROOT || join(import.meta.dirname, '..');

function runtime(overrides: Partial<SpineRuntimeStatus>): SpineRuntimeStatus {
  return {
    kind: 'appliance-image',
    manifest_valid: true,
    repair_required: false,
    capabilities: {
      spine_update: false, system_update: true, incus_update: false, control_update: true,
      ui_update: true, app_update: true, image_update: true, recovery: true, health: true,
    },
    ...overrides,
  };
}

test('sealed production and development images derive safe automatic release sources', () => {
  assert.deepEqual(deriveSystemUpdateSelection(runtime({ artifact_kind: 'production' })), {
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'stable',
  });
  assert.deepEqual(deriveSystemUpdateSelection(runtime({
    artifact_kind: 'stable',
    release_source: 'https://github.com/YouEye-Platform/YouEye',
    release_branch: 'main',
  })), { repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'stable' });
  assert.deepEqual(deriveSystemUpdateSelection(runtime({
    artifact_kind: 'development',
    release_source: 'https://forgejo.example.test/youeye/YouEye',
  })), {
    repository_url: 'https://forgejo.example.test/youeye/YouEye',
    channel: 'development',
  });
});

test('alternative release sources require a safe explicit repository and exact identity is retained', () => {
  assert.throws(() => normalizeSystemUpdateSelection({ provider: 'forgejo', channel: 'development' }));
  assert.throws(() => normalizeSystemUpdateSelection({
    channel: 'development', repository_url: 'http://updates.example.test/owner/YouEye',
  }));
  for (const repository_url of [
    'https://user:example@updates.example.test/owner/YouEye',
    'https://updates.example.test/owner/YouEye?source=other',
    'https://updates.example.test/owner/YouEye#source',
    'https://updates.example.test/api/v1/repos/owner/YouEye/releases',
  ]) assert.throws(() => normalizeSystemUpdateSelection({ channel: 'development', repository_url }));
  const digest = 'a'.repeat(64);
  assert.deepEqual(normalizeSystemUpdateSelection({
    channel: 'exact', repository_url: 'https://updates.example.test/owner/YouEye',
    exact_tag: 'appliance-dev-v1.2.3', manifest_sha256: digest, replace_failed: true,
  }), {
    channel: 'exact', repository_url: 'https://updates.example.test/owner/YouEye',
    exact_tag: 'appliance-dev-v1.2.3', manifest_sha256: digest,
  });
});

test('branch mode tracks only a safe signed release branch and exact accepts branch release tags', () => {
  assert.deepEqual(normalizeSystemUpdateSelection({
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'branch', branch: 'codex/phase1-bootstrap-network',
  }), {
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'branch', branch: 'codex/phase1-bootstrap-network',
  });
  assert.throws(() => normalizeSystemUpdateSelection({
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'branch', branch: 'nested//branch',
  }));
  const digest = 'b'.repeat(64);
  assert.deepEqual(normalizeSystemUpdateSelection({
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'exact',
    exact_tag: 'appliance-codex/phase1-bootstrap-network-v1.2.3', manifest_sha256: digest,
  }), {
    repository_url: 'https://github.com/YouEye-Platform/YouEye', channel: 'exact',
    exact_tag: 'appliance-codex/phase1-bootstrap-network-v1.2.3', manifest_sha256: digest,
  });
});

test('automatic checker only discovers metadata and never stages or restarts', () => {
  const checker = readFileSync(join(root, 'src/lib/appliance/system-update-checker.ts'), 'utf8');
  const instrumentation = readFileSync(join(root, 'src/instrumentation.ts'), 'utf8');
  assert.match(checker, /checkApplianceSystemUpdate/);
  assert.doesNotMatch(checker, /stageApplianceSystemUpdate|activateApplianceSystemUpdate/);
  assert.match(checker, /6 \* 60 \* 60 \* 1000/);
  assert.match(instrumentation, /startSystemUpdateChecker/);
});
