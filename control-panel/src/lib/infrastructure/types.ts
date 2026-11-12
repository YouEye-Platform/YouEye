/**
 * Infrastructure deployment types for OCI and LXD container management.
 * Used by the deployment orchestrator to create and manage YouEye infrastructure.
 */

/** OCI container manifest — apps deployed from Docker/OCI images via Incus */
export interface OCIManifest {
  name: string;
  displayName: string;
  image: string; // e.g. "docker.io/library/caddy" or "ghcr.io/example/app:1.0"
  /** Exact locally imported recovery image; avoids any registry dependency. */
  imageFingerprint?: string;
  containerName: string;
  command?: string; // OCI entrypoint override (e.g. "dumb-init -- ak server")
  ports: PortMapping[];
  environment: Record<string, string>;
  volumes: VolumeMapping[];
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

/** Incus-managed custom volume or a platform-owned read-only bind mount. */
export type VolumeMapping = {
  kind: 'custom';
  pool: string;
  source: string;
  container: string;
  readOnly?: boolean;
} | {
  kind: 'bind';
  host: string;
  container: string;
  readOnly?: boolean;
};

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
  entryFile?: string;
  runtime?: 'node' | 'bun';
  /** Wait for the owning provisioner to write configuration before starting. */
  deferStart?: boolean;
  postInstallCommands?: string[];
  volumes?: VolumeMapping[];
}

/** Deployment progress event sent via SSE to caller */
export interface DeploymentEvent {
  step: number;
  totalSteps: number;
  status: 'running' | 'success' | 'error' | 'skipped';
  message: string;
  detail?: string;
  deploymentId?: string;
  sequence?: number;
  terminal?: boolean;
}

export type DeploymentJobKind = 'deploy' | 'reconcile';

export type DeploymentJobStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'indeterminate';

export interface DeploymentJobState {
  id: string;
  kind: DeploymentJobKind;
  hostIP: string;
  status: DeploymentJobStatus;
  ownerPID: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  events: DeploymentEvent[];
  failure?: {
    step: number;
    message: string;
    detail?: string;
  };
}
