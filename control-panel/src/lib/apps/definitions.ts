/**
 * Unified App Definitions
 *
 * Single source of truth for all YouEye services. Eventually these definitions
 * will be generated from YouEye-file.yaml manifests, but for now they are
 * hardcoded for the existing infrastructure apps.
 */

/**
 * Static definition of an app — metadata that never changes at runtime.
 * This will later be populated by parsing YouEye-file.yaml manifests.
 */
export interface AppDefinition {
  /** Unique identifier (lowercase, used in URLs) */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** Short description */
  description: string;
  /** Lucide icon name */
  icon: string;
  /** Broad category */
  category: 'system' | 'infrastructure' | 'user';
  /** Deployment type — maps to YouEye manifest "type" field */
  type: 'system' | 'oci-single' | 'oci-multi' | 'lxd' | 'youeye-native' | 'docker-lxd';
  /** Containers belonging to this app (empty for host-level system components) */
  containers: AppContainer[];
  /** OCI image reference for update detection (optional) */
  imageRef?: string;
  /** Who performs the update */
  updatedBy: 'control-panel' | 'spine';
  /** Web UI port inside the container (if applicable) */
  webPort?: number;
  /** LXD app configuration for updates (required when type=lxd and updatedBy=control-panel) */
  lxdConfig?: {
    giteaRepo: string;
    /** Tag prefix for monorepo releases (e.g. 'ui' for ui-v0.2.21). Empty for standalone repos. */
    tagPrefix?: string;
    appDir: string;
    serviceName: string;
    healthEndpoint?: string;
  };
  /** Links to existing management pages (temporary) */
  managementLinks?: Array<{ label: string; href: string }>;
}

export interface AppContainer {
  /** Incus container name */
  name: string;
  /** Whether start/stop/restart is allowed */
  canControl: boolean;
}

/** All known app definitions */
export const APP_DEFINITIONS: AppDefinition[] = [
  // ─── System Components ──────────────────────────────────────
  {
    id: 'host-system',
    displayName: 'Host System',
    description: 'Host operating system and packages',
    icon: 'Server',
    category: 'system',
    type: 'system',
    containers: [],
    updatedBy: 'spine',
  },
  {
    id: 'incus',
    displayName: 'Incus',
    description: 'Container and VM management engine',
    icon: 'Box',
    category: 'system',
    type: 'system',
    containers: [],
    updatedBy: 'spine',
  },
  {
    id: 'spine',
    displayName: 'Spine',
    description: 'System management service',
    icon: 'Cog',
    category: 'system',
    type: 'system',
    containers: [],
    updatedBy: 'spine',
  },
  {
    id: 'control-panel',
    displayName: 'Control Panel',
    description: 'Web management interface',
    icon: 'Monitor',
    category: 'system',
    type: 'system',
    containers: [{ name: 'youeye-control', canControl: false }],
    updatedBy: 'spine',
  },

  // ─── Infrastructure Apps ────────────────────────────────────
  {
    id: 'postgres',
    displayName: 'PostgreSQL',
    description: 'Relational database for app data storage',
    icon: 'Database',
    category: 'infrastructure',
    type: 'oci-single',
    containers: [{ name: 'youeye-postgres', canControl: true }],
    imageRef: 'docker.io/library/postgres:17-alpine',
    updatedBy: 'control-panel',
  },
  {
    id: 'authentik',
    displayName: 'Authentik',
    description: 'Identity provider and user management',
    icon: 'ShieldCheck',
    category: 'infrastructure',
    type: 'oci-multi',
    containers: [
      { name: 'youeye-authentik', canControl: true },
      { name: 'youeye-authentik-worker', canControl: true },
    ],
    imageRef: 'ghcr.io/goauthentik/server:2025.12',
    webPort: 9000,
    updatedBy: 'control-panel',
    managementLinks: [{ label: 'People', href: '/people' }],
  },
  {
    id: 'caddy',
    displayName: 'Caddy',
    description: 'Reverse proxy with automatic HTTPS',
    icon: 'Globe',
    category: 'infrastructure',
    type: 'oci-single',
    containers: [{ name: 'youeye-caddy', canControl: true }],
    imageRef: 'docker.io/library/caddy',
    updatedBy: 'control-panel',
    managementLinks: [{ label: 'Reverse Proxy', href: '/proxy' }],
  },
  {
    id: 'pihole',
    displayName: 'Pi-Hole',
    description: 'Network-wide ad blocking DNS',
    icon: 'Shield',
    category: 'infrastructure',
    type: 'oci-single',
    containers: [{ name: 'youeye-pihole', canControl: true }],
    imageRef: 'docker.io/pihole/pihole:latest',
    webPort: 80,
    updatedBy: 'control-panel',
    managementLinks: [{ label: 'DNS Management', href: '/dns' }],
  },
  {
    id: 'ui',
    displayName: 'YouEye UI',
    description: 'User dashboard with widgets and themes',
    icon: 'LayoutDashboard',
    category: 'infrastructure',
    type: 'lxd',
    containers: [{ name: 'youeye-ui', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YouEye',
      tagPrefix: 'ui',
      appDir: '/opt/youeye-ui',
      serviceName: 'youeye-ui',
      healthEndpoint: '/api/health',
    },
  },

  // ─── Native Apps ────────────────────────────────────────────
  {
    id: 'ye-wiki',
    displayName: 'Wiki',
    description: 'Privacy-friendly Wikipedia reader',
    icon: 'BookOpen',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-wiki', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Wiki',
      appDir: '/opt/app',
      serviceName: 'ye-app-wiki',
      healthEndpoint: '/api/health',
    },
  },
  {
    id: 'ye-search',
    displayName: 'Search',
    description: 'Privacy-respecting search engine',
    icon: 'Search',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-search', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Search',
      appDir: '/opt/app',
      serviceName: 'ye-app-search',
      healthEndpoint: '/api/health',
    },
  },
  {
    id: 'ye-notes',
    displayName: 'Notes',
    description: 'Personal note-taking app',
    icon: 'StickyNote',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-notes', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Notes',
      appDir: '/opt/app',
      serviceName: 'ye-app-notes',
      healthEndpoint: '/api/health',
    },
  },
  {
    id: 'ye-cinema',
    displayName: 'Cinema',
    description: 'Movie and TV show discovery',
    icon: 'Film',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-cinema', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Cinema',
      appDir: '/opt/app',
      serviceName: 'ye-app-cinema',
      healthEndpoint: '/api/health',
    },
  },
  {
    id: 'ye-weather',
    displayName: 'Weather',
    description: 'Weather forecasts and conditions',
    icon: 'CloudSun',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-weather', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Weather',
      appDir: '/opt/app',
      serviceName: 'ye-app-weather',
      healthEndpoint: '/api/health',
    },
  },
  {
    id: 'ye-translate',
    displayName: 'Translate',
    description: 'Text translation service',
    icon: 'Languages',
    category: 'user',
    type: 'lxd',
    containers: [{ name: 'ye-app-translate', canControl: true }],
    updatedBy: 'control-panel',
    webPort: 3000,
    lxdConfig: {
      giteaRepo: 'YE-App-Translate',
      appDir: '/opt/app',
      serviceName: 'ye-app-translate',
      healthEndpoint: '/api/health',
    },
  },
];

/** Look up an app definition by ID */
export function getAppDefinition(id: string): AppDefinition | undefined {
  return APP_DEFINITIONS.find((a) => a.id === id);
}

/** Look up an app definition by container name */
export function getAppByContainer(containerName: string): AppDefinition | undefined {
  return APP_DEFINITIONS.find((a) =>
    a.containers.some((c) => c.name === containerName)
  );
}

/**
 * Generate an AppDefinition from a marketplace/native app manifest.
 * Used for dynamically-installed apps that aren't in the static APP_DEFINITIONS list.
 */
export function appDefinitionFromManifest(
  manifest: { metadata: { id: string; name: string; description: string; icon: string };
    native?: { repo: string; containerName: string; port: number; appDir?: string; healthCheck?: { type: string; path?: string } };
    containers?: Array<{ name: string; primary?: boolean; image?: string; port?: number; healthCheck?: unknown }>;
    type?: string },
  installMeta?: { subdomain?: string }
): AppDefinition {
  const isNative = !!manifest.native;
  const appId = manifest.metadata.id;

  if (isNative) {
    const n = manifest.native!;
    const repoName = n.repo.includes('/') ? n.repo.split('/').pop()! : n.repo;
    return {
      id: appId,
      displayName: manifest.metadata.name,
      description: manifest.metadata.description,
      icon: manifest.metadata.icon,
      category: 'user',
      type: 'lxd',
      containers: [{ name: n.containerName, canControl: true }],
      updatedBy: 'control-panel',
      webPort: n.port,
      lxdConfig: {
        giteaRepo: repoName,
        appDir: n.appDir || '/opt/app',
        serviceName: n.containerName,
        healthEndpoint: n.healthCheck?.type === 'http' ? (n.healthCheck.path || '/api/health') : '/api/health',
      },
    };
  }

  // OCI marketplace app
  const containers = manifest.containers || [];
  return {
    id: appId,
    displayName: manifest.metadata.name,
    description: manifest.metadata.description,
    icon: manifest.metadata.icon,
    category: 'user',
    type: containers.length > 1 ? 'oci-multi' : 'oci-single',
    containers: containers.map((c) => ({
      name: containers.length === 1 ? `app-${appId}` : `app-${appId}-${c.name}`,
      canControl: true,
    })),
    imageRef: containers.find((c) => c.primary)?.image || containers[0]?.image,
    updatedBy: 'control-panel',
    webPort: containers.find((c) => c.primary)?.port || containers[0]?.port,
  };
}

/**
 * Map from image reference (as used in manifests) to Incus rebuild source format.
 * For rebuilding OCI containers via Incus REST API.
 */
export function imageRefToIncusSource(imageRef: string): {
  server: string;
  protocol: string;
  alias: string;
} {
  const firstSlash = imageRef.indexOf('/');
  if (firstSlash === -1) {
    return { server: 'https://docker.io', protocol: 'oci', alias: `library/${imageRef}` };
  }
  const serverPart = imageRef.substring(0, firstSlash);
  const alias = imageRef.substring(firstSlash + 1);
  return { server: `https://${serverPart}`, protocol: 'oci', alias };
}
