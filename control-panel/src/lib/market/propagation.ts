/**
 * Settings Propagation Engine
 *
 * Propagates platform settings changes (SMTP, site name, timezone, locale)
 * to all running marketplace and native app containers.
 *
 * Two tiers:
 *   Tier A — SMTP: apps use the mail proxy (POST /api/mail/send), so SMTP
 *            credential changes never need container restarts.
 *   Tier B — Everything else: PATCH env vars on containers + restart.
 *
 * The reconfigure engine already handles domain/subdomain changes.
 * This module handles the remaining settings that were previously
 * fire-and-forget at install time.
 */

import { settingsService } from '@/lib/settings';
import { readSmtpPassword } from '@/lib/smtp/secrets';
import { incusRequest } from '@/lib/incus/server';
import { listInstalledApps, readInstallMetadata } from './metadata';
import { getPlatformContext, clearPlatformContextCache } from './platform-env';
import { fetchManifest } from './catalog';

export interface PropagationResult {
  appsUpdated: string[];
  appsFailed: string[];
  errors: string[];
}

/**
 * Propagate platform env vars to all installed apps.
 * Called when site name, timezone, or locale changes.
 *
 * Updates these container env vars:
 *   YOUEYE_SITE_NAME, YOUEYE_TIMEZONE, YOUEYE_LOCALE, YOUEYE_PLATFORM_VERSION
 */
export async function propagateSettingsToApps(): Promise<PropagationResult> {
  const result: PropagationResult = {
    appsUpdated: [],
    appsFailed: [],
    errors: [],
  };

  // Clear platform context cache so we get fresh values
  clearPlatformContextCache();

  const platform = await getPlatformContext();
  const installedApps = await listInstalledApps();

  if (installedApps.length === 0) return result;

  const envUpdates: Record<string, string> = {
    'environment.YOUEYE_SITE_NAME': platform.siteName,
    'environment.YOUEYE_TIMEZONE': platform.timezone,
    'environment.YOUEYE_LOCALE': platform.locale,
    'environment.YOUEYE_PLATFORM_VERSION': platform.version,
  };

  for (const app of installedApps) {
    const containers = app.containers || [];
    if (containers.length === 0) continue;

    let anyFailed = false;

    for (const containerName of containers) {
      try {
        // PATCH only the platform env vars — preserves all other env
        await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
          config: envUpdates,
        });
      } catch (err) {
        anyFailed = true;
        result.errors.push(`${containerName}: ${err}`);
      }
    }

    // Restart containers to pick up new env vars
    if (!anyFailed) {
      for (const containerName of containers) {
        try {
          await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
            action: 'restart',
            force: true,
            timeout: 30,
          });
        } catch {
          // Container may not be running — not critical
        }
      }
      result.appsUpdated.push(app.appId);
    } else {
      result.appsFailed.push(app.appId);
    }
  }

  return result;
}

/**
 * Propagate a single env var change to all installed apps.
 * Used for targeted updates (e.g., just site name).
 */
export async function propagateEnvVar(
  envKey: string,
  envValue: string
): Promise<PropagationResult> {
  const result: PropagationResult = {
    appsUpdated: [],
    appsFailed: [],
    errors: [],
  };

  const installedApps = await listInstalledApps();
  if (installedApps.length === 0) return result;

  for (const app of installedApps) {
    const containers = app.containers || [];
    if (containers.length === 0) continue;

    let anyFailed = false;

    for (const containerName of containers) {
      try {
        await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
          config: { [`environment.${envKey}`]: envValue },
        });

        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart',
          force: true,
          timeout: 30,
        });
      } catch (err) {
        anyFailed = true;
        result.errors.push(`${containerName}: ${err}`);
      }
    }

    if (anyFailed) {
      result.appsFailed.push(app.appId);
    } else {
      result.appsUpdated.push(app.appId);
    }
  }

  return result;
}

/**
 * Propagate SMTP credential changes to apps that declared capabilities.smtp.
 * Only updates apps whose manifest declares SMTP capability — others are skipped.
 * Restarts affected containers so they pick up the new env vars.
 */
export async function propagateSmtpToApps(): Promise<PropagationResult> {
  const result: PropagationResult = {
    appsUpdated: [],
    appsFailed: [],
    errors: [],
  };

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

  const installedApps = await listInstalledApps();
  if (installedApps.length === 0) return result;

  for (const app of installedApps) {
    // Check if this app declared SMTP capability
    let hasSmtp = false;
    try {
      const manifest = await fetchManifest(app.appId);
      hasSmtp = !!manifest?.capabilities?.smtp;
    } catch {
      // Can't fetch manifest — skip
      continue;
    }

    if (!hasSmtp) continue;

    const containers = app.containers || [];
    if (containers.length === 0) continue;

    let anyFailed = false;

    for (const containerName of containers) {
      try {
        await incusRequest('PATCH', `/1.0/instances/${containerName}`, {
          config: envUpdates,
        });
        await incusRequest('PUT', `/1.0/instances/${containerName}/state`, {
          action: 'restart',
          force: true,
          timeout: 30,
        });
      } catch (err) {
        anyFailed = true;
        result.errors.push(`${containerName}: ${err}`);
      }
    }

    if (anyFailed) {
      result.appsFailed.push(app.appId);
    } else {
      result.appsUpdated.push(app.appId);
    }
  }

  return result;
}
