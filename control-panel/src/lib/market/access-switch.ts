import { readInstalledAppManifest } from './frozen-manifest';
import { updateForwardAuthEnabled } from './installed-apps';
import { readInstallMetadata, saveInstallMetadata } from './metadata';
import { gateOnlyReason, type GateOnlyReason } from './public-access';
import { OFFICIAL_MARKET_SOURCE_ID } from './source';
import { withAppLifecycle } from './update-admission';

/**
 * The installed side of the "Only <site> users" switch (YE-154): why an installed app must stay for users only
 * (from its frozen manifest and the source it was installed from), and the install record's `forwardAuthEnabled`,
 * written with every change of the switch for older readers.
 */
export async function installedGateOnlyReason(appId: string): Promise<GateOnlyReason | null> {
  const metadata = await readInstallMetadata(appId);
  if (!metadata) return null;
  // Without a readable model the lock cannot be decided: refuse opening (the safe side).
  const manifest = await readInstalledAppManifest(appId).catch(() => null);
  if (!manifest) return 'no-sign-in';
  return gateOnlyReason(manifest, (metadata.sourceId ?? OFFICIAL_MARKET_SOURCE_ID) === OFFICIAL_MARKET_SOURCE_ID);
}

/** What the Access settings say next to the switch: the lock, the app's address, and whether YouEye ID signs in. */
export async function installedAccessFacts(appId: string): Promise<{
  gateOnly: GateOnlyReason | null; host: string | null; youEyeSignIn: boolean; siteName: string;
}> {
  const metadata = await readInstallMetadata(appId);
  const { getPlatformContext } = await import('./platform-env');
  const siteName = await getPlatformContext().then((context) => context.siteName || 'YouEye', () => 'YouEye');
  return {
    gateOnly: await installedGateOnlyReason(appId),
    host: metadata?.subdomain && metadata.domain ? `${metadata.subdomain}.${metadata.domain}` : null,
    youEyeSignIn: Boolean(metadata?.enableSSO),
    siteName,
  };
}

/**
 * Dual-write after the policy changed: the record's `forwardAuthEnabled` is "only users" for apps without their own
 * YouEye ID login, as an install writes it. Apps with their own login keep their old optional-gate flag (the
 * independent copy and the sign-in switch read it with that meaning). Returns whether the record changed.
 */
export async function recordOnlyUsers(appId: string, onlyUsers: boolean): Promise<boolean> {
  return withAppLifecycle(appId, async () => {
    const metadata = await readInstallMetadata(appId);
    if (!metadata || metadata.enableSSO || metadata.selectedIntegrations?.includes('youeye-id')) return false;
    if (metadata.forwardAuthEnabled === onlyUsers && metadata.protectWithAccountLogin === onlyUsers) return false;
    metadata.forwardAuthEnabled = onlyUsers;
    metadata.protectWithAccountLogin = onlyUsers;
    await saveInstallMetadata(metadata);
    await updateForwardAuthEnabled(appId, onlyUsers);
    return true;
  });
}
