import type { InstallConfig } from './types';

/** The YouEye ID account behind an install request, if it has one. */
export interface InstallAIUser {
  id: string;
  username: string;
  name?: string | null;
}

/**
 * Decide AI Settings for an AI-capable install. Only `enabled` and
 * `modelGroupId` come from the caller; the owner is always the signed-in
 * YouEye ID user.
 *
 * AI Settings use the installing person's own Pointer model groups, so they
 * need a YouEye ID user. A request with no user (the `youeye app install` CLI)
 * that does not ask for AI Settings installs with them off, exactly like the
 * Install screen's "Use AI Settings" switch turned off: `${ai.*}` stay empty
 * and providers are configured inside the app. AI Settings can be turned on
 * later in Settings → Apps. Explicitly asking for them without a user is
 * still refused.
 */
export function resolveInstallAISettings(
  requested: InstallConfig['aiSettings'] | undefined,
  user: InstallAIUser | null,
): { aiSettings: NonNullable<InstallConfig['aiSettings']> } | { error: string } {
  const enabled = requested?.enabled ?? user !== null;
  if (!enabled) return { aiSettings: { enabled: false } };
  if (!user) {
    return { error: 'Using AI Settings requires a YouEye user account; turn it off to configure providers inside the app' };
  }
  return {
    aiSettings: {
      enabled: true,
      modelGroupId: requested?.modelGroupId,
      ownerUserId: user.id,
      ownerDisplayName: user.name || user.username,
    },
  };
}
