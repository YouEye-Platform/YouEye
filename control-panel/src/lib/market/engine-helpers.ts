/**
 * Shared helpers for the market engine.
 * Extracted to avoid circular dependencies between engine.ts, platform-env.ts, updater.ts.
 */

/**
 * Compute the Incus container name for an app's container.
 * Single-container apps: app-{appId}
 * Multi-container apps: app-{appId}-{containerName}
 */
export function getContainerName(appId: string, containerName: string, totalContainers: number): string {
  if (totalContainers <= 1) {
    return `app-${appId}`;
  }
  return `app-${appId}-${containerName}`;
}
