import { withPlatformLifecycle } from '../market/update-admission';
import type { CoreUpdateStatus } from '../spine/client';
import { readCoreUpdateStatus } from '../updates/core-guard';
import { coreSchemaComponent } from '../updates/core-schema';

/** A single-step retry cannot complete an otherwise unfinished operation. */
export function assertProvisioningStepsComplete(steps: Record<string, unknown>): void {
  const incomplete = ['config', 'caddy', 'dns', 'ai', 'sso_control', 'sso_ui'].filter(step => steps[step] !== 'done');
  if (incomplete.length) throw new Error(`Setup steps still need attention: ${incomplete.join(', ')}. Resume the existing setup.`);
}

/** Retained installation acceptance, deliberately not a fresh payload scan. */
export function assertSetupReadiness(status: CoreUpdateStatus, manifest: string | null): void {
  if (status.schema !== 'youeye.core-status.v1' || status.managed !== true || !status.installed
    || !manifest || status.installed.manifest_sha256 !== manifest || status.installed.machine_bound !== true
    || !/^[a-f0-9]{64}$/.test(status.installed.manifest_sha256)
    || !Number.isFinite(Date.parse(status.installed.accepted_at)) || !status.installed.release?.version
    || status.installed.payload_observation !== 'not-observed'
    || (status.transaction && (status.transaction.complete !== true || !['committed', 'rolled-back', 'cancelled'].includes(status.transaction.phase)))) {
    throw new Error('Installed System acceptance is incomplete or conflicts with setup. Reconcile its existing update or recovery before continuing.');
  }
}
export async function requireSetupReadiness(): Promise<void> {
  const [status, component] = await Promise.all([readCoreUpdateStatus(), coreSchemaComponent('cp')]);
  assertSetupReadiness(status, component?.manifestSHA256 ?? null);
}

/** For atomic setup configuration effects that have their own operation journal. */
export function withReadySetupWork<T>(work: () => T | Promise<T>): Promise<T> {
  return withPlatformLifecycle(async () => { await requireSetupReadiness(); return work(); });
}

/** The authentication method comes from the protected server session. */
export function withSetupRequestWork<T>(authMethod: string | undefined, work: () => T | Promise<T>): Promise<T> {
  return authMethod === 'setup' ? withReadySetupWork(work) : withPlatformLifecycle(work);
}
