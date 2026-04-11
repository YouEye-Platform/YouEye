/**
 * Containers API
 * 
 * Lists YouEye containers with web UIs available for proxy routing.
 * This powers the unified proxy configuration UI.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { incusRequest } from '@/lib/incus/server';
import { getAppManifests } from '@/lib/apps/manifest';
import type { AppManifest } from '@/lib/apps/manifest';
import { getRoutes } from '@/lib/caddy/client';

/**
 * Routable container info for the UI
 */
export interface RoutableContainer {
  /** Container name (e.g., youeye-control) */
  name: string;
  /** Display name for UI (e.g., Control Panel) */
  displayName: string;
  /** Container status (running, stopped, etc.) */
  status: string;
  /** Web UI port inside the container */
  webPort: number;
  /** Current route configuration if any */
  currentRoute?: {
    type: 'subdomain' | 'path';
    value: string;
    hostname?: string;
  };
  /** LAN port exposure via Incus proxy device */
  lanPort?: {
    enabled: boolean;
    hostPort: number;
  };
}

/**
 * Special containers that are always available for routing
 * These are not from the app manifest but are part of the YouEye system
 */
const SYSTEM_CONTAINERS: Array<{ name: string; displayName: string; webPort: number }> = [
  {
    name: 'youeye-control',
    displayName: 'Control Panel',
    webPort: 3000,
  },
];

/**
 * Auxiliary route paths that should be ignored when detecting the "main" route
 * These are added by setContainerRoute() for Next.js static asset support
 */
const AUXILIARY_ROUTE_PATHS = ['/_next/*', '/_next', '/favicon.ico'];

/**
 * GET /api/containers - List containers with web UIs available for routing
 */
export async function GET() {
  try {
    // Check authentication
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const routableContainers: RoutableContainer[] = [];
    
    // Get all Incus instances
    const instancesResponse = await incusRequest<string[]>('GET', '/1.0/instances');
    const instancePaths = instancesResponse.metadata || [];
    
    // Get existing Caddy routes to determine current routing
    let existingRoutes: Awaited<ReturnType<typeof getRoutes>> = [];
    try {
      existingRoutes = await getRoutes();
    } catch {
      // Caddy may not be running, that's OK
    }
    
    // Get app manifests to find web ports
    const manifests = getAppManifests();

    /** Detect lan-web proxy device on a container */
    async function getLanPort(containerName: string): Promise<RoutableContainer['lanPort']> {
      try {
        interface InstanceFull { devices: Record<string, Record<string, string>> }
        const res = await incusRequest<InstanceFull>('GET', `/1.0/instances/${containerName}`);
        const dev = res.metadata?.devices?.['lan-web'];
        if (dev?.type === 'proxy' && dev.listen) {
          const match = dev.listen.match(/:(\d+)$/);
          if (match) return { enabled: true, hostPort: parseInt(match[1], 10) };
        }
      } catch { /* ignore */ }
      return undefined;
    }
    
    // Process system containers first
    for (const sysContainer of SYSTEM_CONTAINERS) {
      // Check if container exists and get its status
      const instancePath = instancePaths.find(p => p.endsWith(`/${sysContainer.name}`));
      
      if (instancePath) {
        try {
          const stateResponse = await incusRequest<{ status: string }>(
            'GET',
            `/1.0/instances/${sysContainer.name}/state`
          );
          
          const status = stateResponse.metadata?.status || 'unknown';
          
          // Find existing route for this container
          // Filter out auxiliary routes (/_next/*, /favicon.ico) that are added for Next.js support
          const existingRoute = existingRoutes.find(r => {
            const isThisContainer = r.upstream === sysContainer.name || 
              r.upstream === `${sysContainer.name}.incus`;
            if (!isThisContainer) return false;
            
            // Skip auxiliary routes
            const path = r.path || '/*';
            if (AUXILIARY_ROUTE_PATHS.some(aux => path.startsWith(aux.replace('/*', '')) || path === aux)) {
              return false;
            }
            return true;
          });
          
          let currentRoute: RoutableContainer['currentRoute'];
          if (existingRoute) {
            // Determine if it's a subdomain or path route
            const isPathRoute = existingRoute.path && existingRoute.path !== '/*';
            currentRoute = {
              type: isPathRoute ? 'path' : 'subdomain',
              value: isPathRoute 
                ? existingRoute.path 
                : (existingRoute.hostname?.split('.')[0] || ''),
              hostname: existingRoute.hostname,
            };
          }
          
          routableContainers.push({
            name: sysContainer.name,
            displayName: sysContainer.displayName,
            status: status.toLowerCase(),
            webPort: sysContainer.webPort,
            currentRoute,
            lanPort: await getLanPort(sysContainer.name),
          });
        } catch (error) {
          console.error(`Failed to get state for ${sysContainer.name}:`, error);
        }
      }
    }
    
    // Process app manifest containers
    for (const manifest of manifests) {
      // Skip containers without web UI or system containers (already processed)
      if (!manifest.webPort) continue;
      if (SYSTEM_CONTAINERS.some(s => s.name === manifest.containerName)) continue;
      if (manifest.name === 'caddy') continue; // Caddy is the proxy, not a target
      
      const instancePath = instancePaths.find(p => p.endsWith(`/${manifest.containerName}`));
      
      if (instancePath) {
        try {
          const stateResponse = await incusRequest<{ status: string }>(
            'GET',
            `/1.0/instances/${manifest.containerName}/state`
          );
          
          const status = stateResponse.metadata?.status || 'unknown';
          
          // Find existing route for this container
          // Filter out auxiliary routes (/_next/*, /favicon.ico) that are added for Next.js support
          const existingRoute = existingRoutes.find(r => {
            const isThisContainer = r.upstream === manifest.containerName || 
              r.upstream === `${manifest.containerName}.incus`;
            if (!isThisContainer) return false;
            
            // Skip auxiliary routes
            const path = r.path || '/*';
            if (AUXILIARY_ROUTE_PATHS.some(aux => path.startsWith(aux.replace('/*', '')) || path === aux)) {
              return false;
            }
            return true;
          });
          
          let currentRoute: RoutableContainer['currentRoute'];
          if (existingRoute) {
            const isPathRoute = existingRoute.path && existingRoute.path !== '/*';
            currentRoute = {
              type: isPathRoute ? 'path' : 'subdomain',
              value: isPathRoute 
                ? existingRoute.path 
                : (existingRoute.hostname?.split('.')[0] || ''),
              hostname: existingRoute.hostname,
            };
          }
          
          routableContainers.push({
            name: manifest.containerName,
            displayName: manifest.displayName,
            status: status.toLowerCase(),
            webPort: manifest.webPort,
            currentRoute,
            lanPort: await getLanPort(manifest.containerName),
          });
        } catch (error) {
          console.error(`Failed to get state for ${manifest.containerName}:`, error);
        }
      }
    }

    return NextResponse.json({
      containers: routableContainers,
    });
  } catch (error) {
    console.error('Error listing containers:', error);
    return NextResponse.json(
      { 
        error: 'Failed to list containers',
        details: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
