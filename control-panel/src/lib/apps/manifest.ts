/**
 * App Manifest Definitions
 * 
 * Lightweight manifest definitions for apps deployed by Spine.
 * These are used for status checking and management only — Spine handles all deployment.
 */

/**
 * App manifest for status/control operations
 */
export interface AppManifest {
  name: string;
  displayName: string;
  description: string;
  containerName: string;
  category: 'networking' | 'storage' | 'monitoring' | 'security' | 'other';
  /** Web UI port inside the container (undefined = no web UI) */
  webPort?: number;
}

/**
 * Caddy reverse proxy — deployed by Spine
 */
export const CADDY_MANIFEST: AppManifest = {
  name: 'caddy',
  displayName: 'Caddy',
  description: 'Fast, multi-platform web server with automatic HTTPS',
  containerName: 'youeye-caddy',
  category: 'networking',
  webPort: undefined,
};

/**
 * Pi-Hole DNS — deployed by Spine
 */
export const PIHOLE_MANIFEST: AppManifest = {
  name: 'pihole',
  displayName: 'Pi-Hole',
  description: 'Network-wide ad blocking',
  containerName: 'youeye-pihole',
  category: 'networking',
  webPort: 80,
};

/**
 * PostgreSQL — deployed by Spine
 */
export const POSTGRES_MANIFEST: AppManifest = {
  name: 'postgres',
  displayName: 'PostgreSQL',
  description: 'Relational database for app data storage',
  containerName: 'youeye-postgres',
  category: 'storage',
  webPort: undefined,
};

/**
 * Authentik — deployed by Spine
 * Web UI on port 9000, accessed via Caddy reverse proxy at auth.youeye.local
 */
export const AUTHENTIK_MANIFEST: AppManifest = {
  name: 'authentik',
  displayName: 'Authentik',
  description: 'Identity provider & user management',
  containerName: 'youeye-authentik',
  category: 'security',
  webPort: 9000,
};

const APP_MANIFESTS: AppManifest[] = [CADDY_MANIFEST, PIHOLE_MANIFEST, POSTGRES_MANIFEST, AUTHENTIK_MANIFEST];

export function getAppManifests(): AppManifest[] {
  return APP_MANIFESTS;
}

export function getAppManifest(name: string): AppManifest | undefined {
  return APP_MANIFESTS.find(m => m.name === name);
}
