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
  // An app without a projected credential has nothing to revoke. Strict UI denies it.
  if (!current) return;
  const revoked = current.status === 'revoked'
    ? current : await appServiceCredentials.revoke(appId, current.revision);
  try {
    await publishCredential(revoked);
  } catch (error) {
    // The dashboard can hold another revision than this store (its database came back from a backup, or an
    // install could not publish): the step-by-step publication is then refused for good, and with it every
    // removal of the app. The revocation is published as a deny-only fence instead, which is all a fence can do.
    try { await publishRestoreFence(appId, true); } catch { throw error; }
  }
}

/**
 * Make the dashboard deny the app at a revision this store agrees with: read what the dashboard holds, take the
 * store's revoked record at or above both revisions (`fenceForRestore`), and publish it as a restore fence. A fence
 * can cross a revision gap only to revoke; it never activates a secret or goes back. Repeating it changes nothing.
 * With `onlyIfKnown`, an app neither side has a record for is left without one. Returns the fence's revision.
 */
async function publishRestoreFence(appId: string, onlyIfKnown: boolean): Promise<number | null> {
  const bridge = await uiBridge();
  const url = `${bridge.origin}/api/ui-bridge/app-credentials/${encodeURIComponent(appId)}/restore-fence`;
  const headers = { 'Content-Type': 'application/json', 'X-UI-Bridge-Token': bridge.token };
  const read = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!read.ok) throw new Error('Restore authority unavailable');
  const body = await read.json();
  const expected = body.credential === null ? null : parseAppCredentialProjection(body.credential);
  if (onlyIfKnown && !expected && !(await appServiceCredentials.projection(appId))) return null;
  const fence = await appServiceCredentials.fenceForRestore(appId, expected);
  const write = await fetch(url, {
    method: 'POST', headers, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ credential: fence, expected }),
  });
  if (!write.ok) throw new Error('Restore fence rejected');
  const receipt = await write.json();
  if (receipt.ok !== true || receipt.revision !== fence.revision) throw new Error('Restore fence receipt mismatch');
  await appServiceCredentials.acknowledgePublication(appId, fence.revision);
  return fence.revision;
}

/** Called by authenticated encrypted app restore after current runtime removal. */
export async function prepareRestoredAppCredential(appId: string): Promise<void> {
  try {
    const revision = await publishRestoreFence(appId, false);
    await appServiceCredentials.prepareReinstall(appId, revision!);
  } catch {
    throw new Error('Restored app credential requires reconciliation');
  }
}

/**
 * After a server restore, for an app that is not installed and is not being reinstalled yet. The dashboard's
 * credential table came back from the backup while this store, outside every restored volume, did not move: the
 * two can name different revisions for the app (the backup's active credential against the revocation of a
 * later removal, or a row against no record at all). The next install publishes one step after this store's
 * revision, the dashboard refuses a step that does not follow its own, and the app is left installed, stopped and
 * "pending" with nothing able to publish, not even its removal. Fencing leaves both sides revoked at one revision.
 */
export async function fenceAbsentAppCredential(appId: string): Promise<void> {
  try {
    await publishRestoreFence(appId, true);
  } catch {
    throw new Error('Absent app credential requires reconciliation');
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
