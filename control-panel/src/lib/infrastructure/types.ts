/**
 * Infrastructure deployment types for OCI and LXD container management.
 * Used by the deployment orchestrator to create and manage YouEye infrastructure.
 */

/** OCI container manifest — apps deployed from Docker/OCI images via Incus */
export interface OCIManifest {
  name: string;
  displayName: string;
  image: string; // e.g. "docker.io/library/caddy" or "ghcr.io/goauthentik/server:2025.12"
  containerName: string;
  command?: string; // OCI entrypoint override (e.g. "dumb-init -- ak server")
  ports: PortMapping[];
  environment: Record<string, string>;
  volumes: VolumeMapping[];
  limits: ResourceLimits;
  // boot.autostart override. Default is true (Incus auto-starts on boot).
  // Set to false for containers that have a host-IP-bound proxy device:
  // Spine becomes responsible for starting them at boot, AFTER it has
  // verified the proxy device's listen address still matches the current
  // host primary IP. Otherwise Incus tries to start the container with a
  // stale listen address, fails to bind, and the container ends up in a
  // wedged half-start state where every subsequent operation hangs.
  // See YE-Wiki/spine/host-ip-migration.md for the full story.
  autostart?: boolean;
}

/** Port mapping between host and container */
export interface PortMapping {
  host: number;
  container: number;
  protocol: 'tcp' | 'udp';
}

/** Volume mount between host filesystem and container */
export interface VolumeMapping {
  host: string;
  container: string;
}

/** Container resource constraints */
export interface ResourceLimits {
  memory: string;
  cpu: string;
}

/** LXD container spec — full OS containers (Debian) with manual app setup */
export interface LXDContainerSpec {
  name: string;
  displayName: string;
  containerName: string;
  image: string; // e.g. "debian/12"
  imageServer: string; // e.g. "https://images.linuxcontainers.org"
  imageProtocol: string; // e.g. "simplestreams"
  nodeVersion: string; // e.g. "22.x"
  appDir: string;
  port: number;
}

/** Deployment progress event sent via SSE to caller */
export interface DeploymentEvent {
  step: number;
  totalSteps: number;
  status: 'running' | 'success' | 'error' | 'skipped';
  message: string;
  detail?: string;
}
