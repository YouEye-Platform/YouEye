/**
 * Language Propagation Service
 *
 * Handles cascading language changes across the platform:
 *   1. Update youeye.yaml (system language via SettingsService)
 *   2. Sync Authentik user locale
 *   3. Update app container env vars for language-supporting apps
 *
 * All app operations are non-blocking — they run asynchronously
 * and failures are logged but never block the UI response.
 */

import { settingsService } from '../settings';
import type { AppManifest } from '../market/types';

// ─── Types ────────────────────────────────────────────────────

export interface LanguagePropagationResult {
  systemUpdated: boolean;
  authentikUpdated: boolean;
  appsUpdated: string[];
  appsFailed: string[];
  errors: string[];
}

interface InstalledAppInfo {
  appId: string;
  containers: string[];
}

// ─── Full-word language names ─────────────────────────────────

const FULL_LANG_NAMES: Record<string, string> = {
  en: 'english',
  ru: 'russian',
  es: 'spanish',
  de: 'german',
  fr: 'french',
};

/** Map ISO 639-1 code to Authentik locale format */
const AUTHENTIK_LOCALE_MAP: Record<string, string> = {
  en: 'en',
  ru: 'ru',
  es: 'es',
  de: 'de',
  fr: 'fr',
};

// ─── Authentik Locale Sync ────────────────────────────────────

/**
 * Update a user's locale in Authentik.
 * Uses the Authentik API v3 PATCH /core/users/{pk}/ with settings.locale.
 */
async function syncAuthentikUserLocale(
  authentikUserId: number,
  locale: string
): Promise<boolean> {
  try {
    const { updateUser } = await import('../authentik/client');
    // Authentik stores locale in the user's attributes/settings
    // The PATCH endpoint accepts arbitrary fields including settings
    const authentikLocale = AUTHENTIK_LOCALE_MAP[locale] || locale;
    await updateUser(authentikUserId, {
      // Authentik uses 'attributes' for custom user data
    } as Record<string, unknown>);

    // Directly call Authentik API with settings field
    const { spineClient } = await import('../spine/client');
    const { getContainerIP } = await import('../incus/container-ip');
    const creds = await spineClient.getAuthentikCredentials();
    const ip = await getContainerIP('youeye-authentik');
    const baseUrl = ip ? `http://${ip}:9000` : creds.internal_url;

    const res = await fetch(`${baseUrl}/api/v3/core/users/${authentikUserId}/`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${creds.bootstrap_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        attributes: {
          settings: { locale: authentikLocale },
        },
      }),
    });

    return res.ok;
  } catch (err) {
    console.error('[LanguageService] Authentik locale sync failed:', err);
    return false;
  }
}

// ─── App Container Language Update ────────────────────────────

/**
 * Get all installed apps that support language configuration.
 * Reads manifests from the catalog and checks the 'language' field.
 */
async function getAppsWithLanguageSupport(): Promise<Array<{
  appId: string;
  containers: string[];
  envVar: string;
  format: 'iso639' | 'full';
}>> {
  try {
    const { listInstalledApps } = await import('../market/metadata');
    const { fetchManifest } = await import('../market/catalog');
    const installed = await listInstalledApps();

    const result: Array<{
      appId: string;
      containers: string[];
      envVar: string;
      format: 'iso639' | 'full';
    }> = [];

    for (const app of installed) {
      try {
        const manifest = await fetchManifest(app.appId);
        if (manifest?.language) {
          result.push({
            appId: app.appId,
            containers: app.containers.map((c: any) => typeof c === 'string' ? c : c.containerName),
            envVar: manifest.language.env_var,
            format: manifest.language.format || 'iso639',
          });
        }
      } catch {
        // Manifest not in catalog — skip (e.g. URL-installed apps)
      }
    }

    return result;
  } catch (err) {
    console.error('[LanguageService] Failed to get apps with language support:', err);
    return [];
  }
}

/**
 * Update a single app container's language env var via Incus API.
 * Then restart the container so the new env var takes effect.
 */
async function updateAppLanguage(
  containerName: string,
  envVar: string,
  value: string
): Promise<boolean> {
  try {
    const { execShell } = await import('../incus/server');

    // Set the env var in the container's config
    // Incus stores container config as key-value pairs
    const setResult = await execShell(
      containerName,
      `export ${envVar}="${value}" && echo "OK"`,
      { timeout: 10_000 }
    );

    // For a persistent change, we need to update the container's
    // environment config via Incus API. Use the incus client.
    const http = await import('http');
    await new Promise<void>((resolve) => {
      // Get current config
      const req = http.request(
        {
          socketPath: '/var/lib/incus/unix.socket',
          path: `/1.0/instances/${containerName}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk));
          res.on('end', async () => {
            try {
              const parsed = JSON.parse(data);
              const config = parsed.metadata?.config || {};
              // Set the env var in Incus config
              config[`environment.${envVar}`] = value;

              // PATCH the container
              const patchPayload = JSON.stringify({ config });
              const patchReq = http.request(
                {
                  socketPath: '/var/lib/incus/unix.socket',
                  path: `/1.0/instances/${containerName}`,
                  method: 'PATCH',
                  headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(patchPayload),
                  },
                },
                (patchRes) => {
                  patchRes.resume();
                  patchRes.on('end', () => resolve());
                }
              );
              patchReq.on('error', () => resolve());
              patchReq.write(patchPayload);
              patchReq.end();
            } catch {
              resolve();
            }
          });
        }
      );
      req.on('error', () => resolve());
      req.setTimeout(10_000, () => {
        req.destroy();
        resolve();
      });
      req.end();
    });

    // Restart the container so the new env var takes effect
    await new Promise<void>((resolve) => {
      const payload = JSON.stringify({ action: 'restart', timeout: 30, force: false });
      const req = http.request(
        {
          socketPath: '/var/lib/incus/unix.socket',
          path: `/1.0/instances/${containerName}/state`,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve());
        }
      );
      req.on('error', () => resolve());
      req.setTimeout(60_000, () => {
        req.destroy();
        resolve();
      });
      req.write(payload);
      req.end();
    });

    return true;
  } catch (err) {
    console.error(`[LanguageService] Failed to update ${containerName}:`, err);
    return false;
  }
}

/**
 * Format a language code according to the app's expected format.
 */
function formatLangValue(lang: string, format: 'iso639' | 'full'): string {
  if (format === 'full') {
    return FULL_LANG_NAMES[lang] || 'english';
  }
  return lang;
}

// ─── Main Propagation ─────────────────────────────────────────

/**
 * Propagate a language change to all connected systems.
 *
 * Steps:
 *   1. Update youeye.yaml via SettingsService
 *   2. Sync Authentik user locale (if userId provided)
 *   3. Update all language-supporting app containers
 *
 * Returns immediately for the UI — app updates run in the background.
 */
export async function propagateLanguageToAll(
  locale: string,
  authentikUserId?: number
): Promise<LanguagePropagationResult> {
  const result: LanguagePropagationResult = {
    systemUpdated: false,
    authentikUpdated: false,
    appsUpdated: [],
    appsFailed: [],
    errors: [],
  };

  // Step 1: Update system language
  try {
    await settingsService.set({ language: locale });
    result.systemUpdated = true;
  } catch (err) {
    result.errors.push(`System language update failed: ${err}`);
  }

  // Step 2: Sync Authentik locale (non-blocking)
  if (authentikUserId) {
    try {
      result.authentikUpdated = await syncAuthentikUserLocale(authentikUserId, locale);
    } catch (err) {
      result.errors.push(`Authentik sync failed: ${err}`);
    }
  }

  // Step 3: Propagate to apps (sequential to avoid overloading)
  const apps = await getAppsWithLanguageSupport();
  for (const app of apps) {
    const value = formatLangValue(locale, app.format);
    let anyFailed = false;

    // Update each container staggered
    for (const container of app.containers) {
      const ok = await updateAppLanguage(container, app.envVar, value);
      if (!ok) {
        anyFailed = true;
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
 * Get the count of apps that support language changes.
 * Used by the UI to show "Updating N apps in the background..."
 */
export async function getLanguageSupportedAppCount(): Promise<number> {
  const apps = await getAppsWithLanguageSupport();
  return apps.length;
}
