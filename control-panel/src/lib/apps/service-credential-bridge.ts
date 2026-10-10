import { readFile } from 'node:fs/promises';
import { getContainerIP as getIncusContainerIP } from '@/lib/incus/container-ip';
import { appServiceCredentials } from './service-credential-store';
import { parseAppCredentialProjection, type AppCredentialProjection } from '../../../../shared/app-service-credential';
import { reconcileRetainedCredential } from './service-credential-retained-restore';

export class AppServiceIntegrationPending extends Error {
  constructor() { super('App service integration is pending; reconcile credentials'); }
}

async function uiBridge() {
  const ip = await getIncusContainerIP('youeye-ui');
  const token = (await readFile('/etc/youeye/ui-bridge-token', 'utf8').catch(() => process.env.UI_BRIDGE_TOKEN ?? '')).trim();
  if (!ip || !token) throw new Error('UI credential bridge is unavailable');
  return { origin: `http://${ip}:3000`, token };
}

/** No foreign transport errors or response bodies enter logs/status. */
export async function publishCredential(
  credential: AppCredentialProjection,
  expectedRevision = credential.revision - 1,
): Promise<void> {
  try {
    const pending = await appServiceCredentials.pendingPublications(credential.appId);
    // Even an acknowledged generation is re-published idempotently to verify
    // the UI did not lose its revision authority during a core-only restore.
    const credentials = pending.length ? pending : [credential];
    if (credentials.at(-1)?.revision !== credential.revision) throw new Error('Publication generation mismatch');
    const bridge = await uiBridge();
    const response = await fetch(`${bridge.origin}/api/ui-bridge/app-credentials/${encodeURIComponent(credential.appId)}`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'X-UI-Bridge-Token': bridge.token },
      body: JSON.stringify({ credentials, expectedRevision: pending.length ? credentials[0].revision - 1 : expectedRevision }),
    });
    if (!response.ok) throw new Error('Publication rejected');
    const receipt = await response.json();
    if (receipt.generation !== credential.generation || receipt.revision !== credential.revision
      || receipt.installationId !== credential.installationId || receipt.status !== credential.status) {
      throw new Error('Publication receipt mismatch');
    }
    await appServiceCredentials.acknowledgePublication(credential.appId, credential.revision);
  } catch {
    throw new Error('App credential publication requires reconciliation');
  }
}

export async function probeCredential(appId: string): Promise<void> {
  try {
    const bridge = await uiBridge();
    const secret = await appServiceCredentials.runtimeSecret(appId);
    const response = await fetch(`${bridge.origin}/api/apps/v1/credential-probe`, {
      signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${secret}`, 'X-YouEye-App': appId },
    });
    if (!response.ok) throw new Error('Probe rejected');
    await response.body?.cancel();
  } catch {
    throw new Error('App service probe requires reconciliation');
  }
}

export async function markCredentialReady(appId: string, ready = true): Promise<void> {
  try {
    const credential = await appServiceCredentials.projection(appId);
    if (!credential || credential.status !== 'active') throw new Error('Credential is unavailable');
    const bridge = await uiBridge();
    const response = await fetch(`${bridge.origin}/api/ui-bridge/app-credentials/${encodeURIComponent(appId)}/ready`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'Content-Type': 'application/json', 'X-UI-Bridge-Token': bridge.token },
      body: JSON.stringify({
        installationId: credential.installationId, generation: credential.generation, revision: credential.revision,
        ready,
      }),
    });
    if (!response.ok || (await response.json()).ok !== true) throw new Error('Readiness rejected');
  } catch {
    throw new Error('App credential readiness requires reconciliation');
  }
}

/** Registration exists and runtime already contains the protected generation. */
export async function activateProvisionedCredential(appId: string, probeRuntime?: () => Promise<void>): Promise<void> {
  let credential = await appServiceCredentials.projection(appId);
  if (!credential || credential.status === 'revoked') throw new Error('App credential requires repair');
  if (credential.status === 'prepared') {
    await publishCredential(credential);
    credential = await appServiceCredentials.activate(appId, credential.revision);
  }
  await publishCredential(credential);
  await probeCredential(appId);
  await probeRuntime?.();
  await markCredentialReady(appId);
}

export async function revokeAppCredential(appId: string): Promise<void> {
  const current = await appServiceCredentials.projection(appId);
  // Legacy installations have no projected credential. Strict UI denies them.
  if (!current) return;
  const revoked = current.status === 'revoked'
    ? current : await appServiceCredentials.revoke(appId, current.revision);
  await publishCredential(revoked);
}

/** Called by authenticated encrypted app restore after current runtime removal. */
export async function prepareRestoredAppCredential(appId: string): Promise<void> {
  try {
    const bridge = await uiBridge();
    const url = `${bridge.origin}/api/ui-bridge/app-credentials/${encodeURIComponent(appId)}/restore-fence`;
    const headers = { 'Content-Type': 'application/json', 'X-UI-Bridge-Token': bridge.token };
    const read = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!read.ok) throw new Error('Restore authority unavailable');
    const body = await read.json();
    const expected = body.credential === null ? null : parseAppCredentialProjection(body.credential);
    const fence = await appServiceCredentials.fenceForRestore(appId, expected);
    const write = await fetch(url, {
      method: 'POST', headers, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ credential: fence, expected }),
    });
    if (!write.ok) throw new Error('Restore fence rejected');
    const receipt = await write.json();
    if (receipt.ok !== true || receipt.revision !== fence.revision) throw new Error('Restore fence receipt mismatch');
    await appServiceCredentials.acknowledgePublication(appId, fence.revision);
    await appServiceCredentials.prepareReinstall(appId, fence.revision);
  } catch {
    throw new Error('Restored app credential requires reconciliation');
  }
}

/** Authenticated core restore; caller retains the runtime and current authority. */
export async function reconcileRetainedAppCredential(appId: string): Promise<'revoked' | 'pending'> {
  try {
    const bridge = await uiBridge();
    const url = `${bridge.origin}/api/ui-bridge/app-credentials/${encodeURIComponent(appId)}/restore-fence`;
    const headers = { 'Content-Type': 'application/json', 'X-UI-Bridge-Token': bridge.token };
    return await reconcileRetainedCredential(appId, appServiceCredentials, {
      async readVerifier() {
        const read = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
        if (!read.ok) throw new Error('Restore verifier unavailable');
        const body = await read.json();
        return body.credential === null ? null : parseAppCredentialProjection(body.credential);
      },
      publish: credential => publishCredential(credential),
      async publishFence(credential, expected) {
        const write = await fetch(url, {
          method: 'POST', headers, signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({ credential, expected }),
        });
        if (!write.ok) throw new Error('Restore fence rejected');
        const receipt = await write.json();
        if (receipt.ok !== true || receipt.revision !== credential.revision) throw new Error('Restore receipt mismatch');
      },
    });
  } catch {
    throw new Error('Retained app service access requires reconciliation');
  }
}
