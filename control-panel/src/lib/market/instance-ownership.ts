/**
 * Ownership of the Incus instances an app install creates.
 *
 * Every instance an install creates carries `user.youeye.app_id` and
 * `user.youeye.installation_id` (the same tags custom volumes and app networks carry).
 * Nothing is ever replaced or deleted by name alone:
 * - an install refuses a target name that already exists (preflight and the deployers);
 * - uninstall, rollback and cleanup delete only the exact names recorded in install.json,
 *   and only when the instance carries this installation's tag.
 *
 * Container names are `app-<id>` (one container) or `app-<id>-<container>`. Ids and container
 * names both allow `-`, so app `foo` with sidecar `bar` and app `foo-bar` would both want
 * `app-foo-bar`: an install whose names are recorded by another installed or retained app
 * is refused in preflight (and Incus already holding the name refuses it too).
 */

import { incusRequest } from '../incus/server';
import type { InstallMetadata } from './types';

export const APP_TAG = 'user.youeye.app_id';
export const INSTALLATION_TAG = 'user.youeye.installation_id';

const INSTANCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export class InstanceOwnershipError extends Error {}

/** An Incus operation still running after every bounded wait (YE-222): its outcome is unknown, so it is not sent again. */
class InstanceOperationRunningError extends InstanceOwnershipError {}

export interface InstanceOwner {
  appId: string;
  installationId: string;
}

/** The creation-time config tags of an instance owned by `owner`. */
export function ownershipConfig(owner: InstanceOwner): Record<string, string> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(owner.appId) || !/^[0-9a-f-]{36}$/.test(owner.installationId)) {
    throw new InstanceOwnershipError('Invalid installation ownership');
  }
  return { [APP_TAG]: owner.appId, [INSTALLATION_TAG]: owner.installationId };
}

export function assertInstanceName(name: string): void {
  if (!INSTANCE_NAME.test(name)) {
    throw new InstanceOwnershipError(`Container name ${name} is not a valid Incus instance name (1–63 chars)`);
  }
}

function recordedNames(record: InstallMetadata): string[] {
  return [
    ...(record.containers ?? []).map((container) =>
      container.containerName),
    ...(record.retainedRoots?.roots ?? []).flatMap((root) => [root.sourceName, root.retainedName]),
  ].filter((name): name is string => Boolean(name));
}

/**
 * Refuse names that are invalid, repeated, or recorded by another installed or retained app
 * (`foo` + sidecar `bar` against `foo-bar`, and the reverse).
 */
export function assertContainerNamesAvailable(appId: string, names: string[], records: InstallMetadata[]): void {
  const seen = new Set<string>();
  for (const name of names) {
    assertInstanceName(name);
    if (seen.has(name)) throw new InstanceOwnershipError(`Container name ${name} is used twice`);
    seen.add(name);
  }
  for (const record of records) {
    if (record.appId === appId) continue;
    const taken = recordedNames(record).find((name) => seen.has(name));
    if (taken) {
      throw new InstanceOwnershipError(
        `Container name ${taken} is already used by installed app ${record.appId}`,
      );
    }
  }
}

type InstanceRead = { type?: string; error_code?: number; status_code?: number; error?: string; metadata?: { name?: string; config?: Record<string, string> } };

/** The instance's config, or null when Incus positively reports it absent. */
export async function readInstanceConfig(name: string): Promise<Record<string, string> | null> {
  assertInstanceName(name);
  const response = await incusRequest('GET', `/1.0/instances/${encodeURIComponent(name)}`) as InstanceRead;
  if (response.type === 'error' && (response.error_code === 404 || response.status_code === 404)) return null;
  if (response.type === 'error' || response.metadata?.name !== name) {
    throw new InstanceOwnershipError(`Instance ${name} could not be inspected`);
  }
  return response.metadata.config ?? {};
}

/** Refuse when any target name already exists in Incus (nothing of a new install exists yet). */
export async function assertInstancesAbsent(names: string[]): Promise<void> {
  for (const name of names) {
    if (await readInstanceConfig(name) !== null) {
      throw new InstanceOwnershipError(
        `An Incus instance named ${name} already exists and does not belong to this install; it is left untouched`,
      );
    }
  }
}

export function isOwnedBy(config: Record<string, string>, owner: InstanceOwner): boolean {
  return config[INSTALLATION_TAG] === owner.installationId && config[APP_TAG] === owner.appId;
}

/** Bounds of a delete: attempts, waits per operation (60 s each), and how long a deleted instance may still read back. */
export const INSTANCE_DELETE_LIMITS = { attempts: 3, waits: 3, retryMs: 2_000, settleMs: 15_000, pollMs: 500 };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type OperationRead = InstanceRead & { metadata?: { status?: string; err?: string } & InstanceRead['metadata'] };

/**
 * Wait for an Incus operation's real outcome: the `operation/wait` answer is an ordinary envelope whether the operation
 * succeeded, failed or is still running, so its `metadata.status` decides (YE-222). Only `Success` passes; `Failure` or
 * `Cancelled` throws with Incus's error; still running after every wait throws as unconfirmed.
 */
async function waitFor(response: { type?: string; operation?: string; error?: string }, what: string): Promise<void> {
  if (response.type === 'error') throw new InstanceOwnershipError(`${what} failed${response.error ? `: ${response.error}` : ''}`);
  if (response.type !== 'async' || !response.operation) return;
  for (let wait = 0; wait < INSTANCE_DELETE_LIMITS.waits; wait++) {
    let waited = await incusRequest('GET', `${response.operation}/wait?timeout=60`, undefined, { timeout: 70_000 }) as OperationRead;
    // A wait that timed out may come back as an error reply while the operation still runs: read the operation itself
    // before calling it failed (YE-222 review). An operation still running after every wait ends the attempts too
    // (InstanceOperationRunningError, deleteOwnedInstance): a running delete is never sent again.
    if (waited.type === 'error') waited = await incusRequest('GET', response.operation) as OperationRead;
    if (waited.type === 'error') throw new InstanceOwnershipError(`${what} failed${waited.error ? `: ${waited.error}` : ''}`);
    const status = waited.metadata?.status;
    if (status === 'Success') return;
    if (status === 'Failure' || status === 'Cancelled' || status === 'Canceled') {
      throw new InstanceOwnershipError(`${what} failed${waited.metadata?.err ? `: ${waited.metadata.err}` : ''}`);
    }
  }
  throw new InstanceOperationRunningError(`${what} did not finish in time`);
}

/** Read the instance until it is gone (a finished delete can take a moment to read back absent). */
async function goneWithin(name: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await readInstanceConfig(name) === null) return true;
    if (Date.now() >= deadline) return false;
    await pause(INSTANCE_DELETE_LIMITS.pollMs);
  }
}

/**
 * Stop and delete the exact instance `name` if it carries `owner`'s tags. Absent is clean.
 * A same-name instance owned by anything else is refused and left untouched.
 */
export async function deleteOwnedInstance(name: string, owner: InstanceOwner | undefined): Promise<'absent' | 'deleted'> {
  const config = await readInstanceConfig(name);
  if (config === null) return 'absent';
  if (!owner?.installationId || !isOwnedBy(config, owner)) {
    throw new InstanceOwnershipError(`Instance ${name} is not tagged with this installation; refusing to delete it`);
  }
  // Forced: the instance is deleted right after. A stop failure (already stopped, never started) is not fatal:
  // delete and its read-back decide.
  try {
    await waitFor(await incusRequest('PUT', `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action: 'stop', force: true, timeout: 30,
    }) as InstanceRead & { operation?: string }, `Stopping ${name}`);
  } catch {
    console.warn(`[market] Could not confirm stop for ${name}; delete verification decides the result`);
  }
  // The delete's own outcome decides, bounded (YE-222): a failed attempt (say Incus was finishing an exec in the
  // stopping container) is tried again; the volumes are deleted only after this reports the instance gone.
  let lastError: unknown;
  for (let attempt = 1; attempt <= INSTANCE_DELETE_LIMITS.attempts; attempt++) {
    if (await readInstanceConfig(name) === null) return 'deleted';
    try {
      await waitFor(await incusRequest('DELETE', `/1.0/instances/${encodeURIComponent(name)}`) as InstanceRead & { operation?: string },
        `Deleting ${name}`);
      if (await goneWithin(name, INSTANCE_DELETE_LIMITS.settleMs)) return 'deleted';
      lastError = new InstanceOwnershipError(`Instance ${name} remains after delete`);
    } catch (error) {
      lastError = error;
      // Still running after every wait: its outcome is unknown, and another DELETE would race it. The removal stays
      // unfinished (the data is kept) and is finished by the next attempt (Iris's batch-1 review, nit c).
      if (error instanceof InstanceOperationRunningError) {
        if (await readInstanceConfig(name) === null) return 'deleted';
        break;
      }
    }
    if (await readInstanceConfig(name) === null) return 'deleted';
    if (attempt < INSTANCE_DELETE_LIMITS.attempts) {
      console.warn(`[market] Delete of ${name} not confirmed (attempt ${attempt}): ${lastError instanceof Error ? lastError.message : String(lastError)}; trying again`);
      await pause(INSTANCE_DELETE_LIMITS.retryMs * attempt);
    }
  }
  throw lastError instanceof InstanceOwnershipError ? lastError
    : new InstanceOwnershipError(`Instance ${name} remains after delete`);
}
