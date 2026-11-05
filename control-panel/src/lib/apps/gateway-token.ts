/**
 * Gateway token validation — re-exports from platform-env.
 * Apps authenticate to the gateway with their identity token.
 */
export { validateAppToken, generateAppToken } from '../market/platform-env';

/**
 * Check if an installed app has a specific capability.
 * Reads the app's manifest from metadata/catalog at request time.
 */
export async function checkAppCapability(appId: string, capability: string): Promise<boolean> {
  try {
    const { readInstallMetadata } = await import('../market/metadata');
    const meta = await readInstallMetadata(appId);
    if (!meta) return false;
    // For now, all installed apps are considered to have all capabilities
    // Full capability checking from manifest will come in v2.1
    return true;
  } catch {
    return false;
  }
}
