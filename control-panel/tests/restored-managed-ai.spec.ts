import assert from 'node:assert/strict';
import test from 'node:test';
import { readRestoredManagedAI, assertRestoredManagedAI, type RestoredManagedAI } from '../src/lib/market/restored-managed-ai';
import type { PointerManagedInstallation } from '../src/lib/pointer/managed-apps';

const saved: RestoredManagedAI = {
  externalInstallationId: 'market:open-webui:20000000-0000-4000-8000-000000000001',
  ownerUserId: '10000000-0000-4000-8000-000000000001', pointerOwnerId: 'owner',
  pointerInstallationId: 'installation', pointerInstanceId: 'instance', modelGroupId: 'group',
  groupName: 'Models', keyPreview: 'protected-preview', credentialSecret: 'pointer_api_key',
  defaultModel: 'default', state: 'active',
};
const current: PointerManagedInstallation = {
  externalInstallationId: saved.externalInstallationId,
  app: { id: 'open-webui', displayName: 'Open WebUI', version: null, adapterRevision: null },
  pointer: { installationId: saved.pointerInstallationId, instanceId: saved.pointerInstanceId },
  routingOwner: { id: saved.pointerOwnerId, displayName: 'Owner', state: 'active', externalSubject: saved.ownerUserId },
  selectedGroup: { id: saved.modelGroupId, name: 'Models', isDefault: true, modelCount: 1, providerCount: 1, unavailableRouteCount: 0 },
  state: 'active', credential: { id: 'key', preview: saved.keyPreview, lifecycle: 'active', generation: 1,
    revoked: false, deliveryState: 'acknowledged' },
  drift: { codes: [], healthy: true, unavailableRouteCount: 0, recoveryActions: [] },
};

test('paired restored AI binding keeps its exact existing identity, including disabled state', () => {
  const before = structuredClone(current);
  assert.deepEqual(readRestoredManagedAI('open-webui', saved), saved);
  assertRestoredManagedAI('open-webui', saved, current, 'protected-fixture');
  assertRestoredManagedAI('open-webui', { ...saved, state: 'disabled' }, { ...current, state: 'disabled' }, 'protected-fixture');
  assert.deepEqual(current, before);
  assert.equal(readRestoredManagedAI('open-webui', undefined), undefined);
});

test('paired restore refuses foreign, missing, revoked, drifting or pending-delivery bindings', () => {
  for (const changed of [{ ownerUserId: 'foreign' }, { externalInstallationId: 'market:other:20000000-0000-4000-8000-000000000001' },
    { credentialSecret: 'other' }, { state: 'needs_attention' }, { pointerInstanceId: '' }])
    assert.throws(() => readRestoredManagedAI('open-webui', { ...saved, ...changed }));
  const variants: PointerManagedInstallation[] = [
    { ...current, externalInstallationId: 'foreign' }, { ...current, app: { ...current.app, id: 'foreign' } },
    { ...current, pointer: { ...current.pointer, instanceId: 'foreign' } },
    { ...current, pointer: { ...current.pointer, installationId: 'foreign' } },
    { ...current, routingOwner: { ...current.routingOwner!, externalSubject: 'foreign' } },
    { ...current, selectedGroup: { ...current.selectedGroup!, id: 'foreign' } },
    { ...current, credential: { ...current.credential!, revoked: true } },
    { ...current, credential: { ...current.credential!, preview: 'foreign' } },
    { ...current, credential: { ...current.credential!, deliveryState: 'pending_acknowledgement' } },
    { ...current, credential: null }, { ...current, state: 'archived' },
    { ...current, drift: { ...current.drift, codes: ['instance_state_mismatch'] } },
  ];
  for (const variant of variants) assert.throws(() => assertRestoredManagedAI('open-webui', saved, variant, 'protected-fixture'));
  assert.throws(() => assertRestoredManagedAI('open-webui', saved, current, null));
});
