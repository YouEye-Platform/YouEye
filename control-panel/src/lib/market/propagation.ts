/**
 * Settings Propagation Engine
 *
 * Writes platform settings into installed apps' container environments and restarts what runs, for the apps
 * whose containers do not hold the values yet:
 *   - SMTP settings (SMTP_*) for apps that declare `capabilities.smtp`;
 *   - site name, timezone, locale and platform version (YOUEYE_*) for every app, after a reconfigure.
 *
 * The reconfigure engine handles domain/subdomain changes itself.
 */

import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { incusRequest } from '@/lib/incus/server';
import { containerState, startContainer, stopContainerOrForce, stopTimeoutSec, waitForRunning } from '@/lib/incus/snapshot';
import { containerTargets, orderContainers } from '@/lib/apps/container-order';
import { listInstalledApps } from './metadata';
import { getPlatformContext, clearPlatformContextCache } from './platform-env';
import { readInstalledAppManifest } from './frozen-manifest';
import { withAppLifecycle } from './update-admission';
import type { InstallMetadata } from './types';

export interface PropagationResult {
  appsUpdated: string[];
  appsFailed: string[];
  errors: string[];
}

/**
 * Set on a container in the same write as new environment values, and cleared once the container has been stopped
 * (its next start reads them) or restarted. While it is set, the container's process may still run with the old
 * values, whatever its config says: a write whose restart never happened (the Control Panel died, a stop failed, a
 * URL change threw after its first step) is finished by the next propagation instead of being taken for done.
 */
export const ENV_RESTART_PENDING = 'user.youeye.env-restart-pending';

type InstanceConfig = { config?: Record<string, string> };

async function instanceConfig(containerName: string): Promise<Record<string, string>> {
  const instance = await incusRequest<InstanceConfig>('GET', `/1.0/instances/${encodeURIComponent(containerName)}`);
  if (instance.type === 'error') throw new Error(`${containerName}: ${instance.error || instance.status}`);
  return instance.metadata?.config ?? {};
}

async function patchConfig(containerName: string, config: Record<string, string>): Promise<void> {
  const patched = await incusRequest('PATCH', `/1.0/instances/${encodeURIComponent(containerName)}`, { config });
  if (patched.type === 'error') throw new Error(`${containerName}: ${patched.error || patched.status}`);
}

const holds = (current: Record<string, string>, config: Record<string, string>) =>
  Object.entries(config).every(([key, value]) => current[key] === value);

/**
 * Write `config` (environment keys) to one container unless it already holds every value. true: it was written,
 * and the container is marked as waiting for its restart (`clearEnvRestartPending` after the caller's restart).
 */
export async function writeContainerEnvironment(containerName: string, config: Record<string, string>): Promise<boolean> {
  if (holds(await instanceConfig(containerName), config)) return false;
  await patchConfig(containerName, { ...config, [ENV_RESTART_PENDING]: '1' });
  return true;
}

/** Mark a container whose environment was changed by other means (its env file) as waiting for its restart. */
export async function markEnvRestartPending(containerName: string): Promise<void> {
  await patchConfig(containerName, { [ENV_RESTART_PENDING]: '1' });
}

/** The container was stopped or restarted after its environment was written (an empty value unsets the key). */
export async function clearEnvRestartPending(containerName: string): Promise<void> {
  if ((await instanceConfig(containerName))[ENV_RESTART_PENDING] !== '1') return;
  await patchConfig(containerName, { [ENV_RESTART_PENDING]: '' });
}

/**
 * Clear a stopped container's mark without failing the restart around it: the containers stopped so far must still
 * be started. A mark that could not be cleared costs one more restart at the next propagation.
 */
async function restartDone(appId: string, containerName: string): Promise<void> {
  try {
    await clearEnvRestartPending(containerName);
  } catch (err) {
    console.warn(`[propagation] ${appId}: restart mark not cleared on ${containerName}:`, err);
  }
}

/** Every container holds every value, and none waits for a restart after an earlier write. */
async function holdsEnvironment(containerNames: string[], config: Record<string, string>): Promise<boolean> {
  for (const containerName of containerNames) {
    let current: Record<string, string>;
    try {
      current = await instanceConfig(containerName);
    } catch {
      return false;
    }
    if (current[ENV_RESTART_PENDING] === '1' || !holds(current, config)) return false;
  }
  return true;
}

/**
 * Write `config` (environment keys) to every container of one app and restart what runs, under the app's lock.
 * An app whose containers all hold every value already, with no restart owed, is left alone: no lock, no write,
 * no restart.
 * The restart is the app's as a whole: clean stops in stop order (forced only after each role's timeout, logged),
 * then starts in start order. A stopped container is not started: it reads the new environment at its next start.
 * A container stops waiting for its restart as soon as it is stopped; one that could not be stopped keeps the mark,
 * and the next propagation restarts the app again. A mark only on containers that neither run nor are stopped
 * (Frozen, or their state can't be read) restarts nothing: they take it at their own next start.
 */
async function applyToApp(app: InstallMetadata, config: Record<string, string>, result: PropagationResult): Promise<void> {
  const containers = app.containers ?? [];
  if (containers.length === 0) return;
  let changed = false;
  try {
    if (await holdsEnvironment(containers.map(container => container.containerName), config)) return;
    await withAppLifecycle(app.appId, async () => {
      const owed = new Set<string>();
      for (const { containerName } of containers) {
        if (await writeContainerEnvironment(containerName, config)) changed = true;
        if ((await instanceConfig(containerName))[ENV_RESTART_PENDING] === '1') owed.add(containerName);
      }
      // Another operation wrote the same values, and restarted, before this one got the app.
      if (owed.size === 0) return;
      // Only a container that runs or is stopped can take its restart. One that is Frozen, or whose state can't be
      // read, keeps its mark, and restarting the app's other containers for it at every propagation would not help.
      let settled = false;
      for (const name of owed) {
        if (['Running', 'Stopped'].includes(await containerState(name))) settled = true;
      }
      if (!settled) return;
      changed = true;
      const restarted: string[] = [];
      for (const { name, role } of orderContainers(containerTargets(containers), 'stop')) {
        const state = await containerState(name);
        if (state === 'Running') {
          await stopContainerOrForce(name, { timeoutSec: stopTimeoutSec(role) });
          restarted.push(name);
        } else if (state !== 'Stopped') {
          // Frozen, or its state could not be read: it keeps the mark for the next propagation.
          continue;
        }
        if (owed.has(name)) await restartDone(app.appId, name);
      }
      for (const name of restarted.reverse()) {
        await startContainer(name);
        await waitForRunning(name, 60);
      }
    });
    if (changed) result.appsUpdated.push(app.appId);
  } catch (err) {
    result.appsFailed.push(app.appId);
    result.errors.push(`${app.appId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The platform keys every app container gets: site name, timezone, locale and platform version, as they are now. */
export async function platformEnvironment(): Promise<Record<string, string>> {
  // Clear platform context cache so we get fresh values
  clearPlatformContextCache();
  const platform = await getPlatformContext();
  return {
    'environment.YOUEYE_SITE_NAME': platform.siteName,
    'environment.YOUEYE_TIMEZONE': platform.timezone,
    'environment.YOUEYE_LOCALE': platform.locale,
    'environment.YOUEYE_PLATFORM_VERSION': platform.version,
  };
}

/**
 * Propagate platform env vars to all installed apps.
 * Called when site name, timezone, or locale changes.
 *
 * Updates these container env vars:
 *   YOUEYE_SITE_NAME, YOUEYE_TIMEZONE, YOUEYE_LOCALE, YOUEYE_PLATFORM_VERSION
 *
 * Only an app that does not hold all four values yet, or whose restart after an earlier write never happened
 * (`ENV_RESTART_PENDING`), is written and restarted, so a reconfigure that changed none of them restarts no app, and
 * one that already wrote them with its own restart (a domain change) restarts none twice.
 */
export async function propagateSettingsToApps(): Promise<PropagationResult> {
  const result: PropagationResult = { appsUpdated: [], appsFailed: [], errors: [] };
  const envUpdates = await platformEnvironment();
  for (const app of await listInstalledApps()) await applyToApp(app, envUpdates, result);
  return result;
}

/**
 * Propagate SMTP credential changes to apps that declared capabilities.smtp.
 * Only updates apps whose manifest declares SMTP capability — others are skipped.
 * Restarts affected containers so they pick up the new env vars; an app that holds every value already is left alone.
 */
export async function propagateSmtpToApps(): Promise<PropagationResult> {
  const result: PropagationResult = { appsUpdated: [], appsFailed: [], errors: [] };

  const settings = await settingsService.getAll();
  const smtpPassword = await readSmtpPassword();
  const smtpConfigured = !!(settings.smtpHost && smtpPassword);

  const envUpdates: Record<string, string> = {
    'environment.SMTP_HOST': settings.smtpHost || '',
    'environment.SMTP_PORT': String(settings.smtpPort || 587),
    'environment.SMTP_USERNAME': settings.smtpUsername || '',
    'environment.SMTP_PASSWORD': smtpPassword,
    'environment.SMTP_FROM': settings.smtpFrom || '',
    'environment.SMTP_TLS': String(settings.smtpRequireTls ?? true),
    'environment.SMTP_CONFIGURED': String(smtpConfigured),
  };

  for (const app of await listInstalledApps()) {
    // Check if this app declared SMTP capability
    let hasSmtp = false;
    try {
      const manifest = await readInstalledAppManifest(app.appId);
      hasSmtp = !!manifest?.capabilities?.smtp;
    } catch {
      // Can't fetch manifest — skip
      continue;
    }
    if (hasSmtp) await applyToApp(app, envUpdates, result);
  }

  return result;
}
