/**
 * Incus API Client
 * 
 * Communicates with Incus daemon via Unix socket at /var/lib/incus/unix.socket
 * This is the same approach Proxmox uses - direct socket communication for security.
 */

interface IncusResponse<T = unknown> {
  type: 'sync' | 'async' | 'error';
  status: string;
  status_code: number;
  operation: string;
  error_code: number;
  error: string;
  metadata: T;
}

interface Container {
  name: string;
  status: string;
  status_code: number;
  architecture: string;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  ephemeral: boolean;
  profiles: string[];
  stateful: boolean;
  description: string;
  created_at: string;
  expanded_config: Record<string, string>;
  expanded_devices: Record<string, Record<string, string>>;
  last_used_at: string;
  location: string;
  type: 'container' | 'virtual-machine';
  project: string;
}

interface ContainerState {
  status: string;
  status_code: number;
  disk: Record<string, { usage: number }>;
  memory: {
    usage: number;
    usage_peak: number;
    total: number;
    swap_usage: number;
    swap_usage_peak: number;
  };
  network: Record<string, {
    addresses: Array<{
      family: string;
      address: string;
      netmask: string;
      scope: string;
    }>;
    counters: {
      bytes_received: number;
      bytes_sent: number;
      packets_received: number;
      packets_sent: number;
    };
    host_name: string;
    mtu: number;
    state: string;
    type: string;
  }>;
  pid: number;
  processes: number;
  cpu: {
    usage: number;
  };
}

interface ServerInfo {
  api_extensions: string[];
  api_status: string;
  api_version: string;
  auth: string;
  auth_methods: string[];
  auth_user_name: string;
  auth_user_method: string;
  environment: {
    server: string;
    server_version: string;
    server_name: string;
    os_name: string;
    os_version: string;
    kernel: string;
    kernel_version: string;
    storage: string;
    storage_version: string;
    [key: string]: unknown;
  };
}

export class IncusClient {
  private socketPath: string;

  constructor(socketPath = '/var/lib/incus/unix.socket') {
    this.socketPath = socketPath;
  }

  /**
   * Make a request to the Incus API
   * In production, this will use the Unix socket directly
   * For now, we'll use a server-side API route as a proxy
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<IncusResponse<T>> {
    // This will be called from the server-side API route
    const response = await fetch(`/api/incus${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      throw new Error(`Incus API error: ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  /**
   * Get server information
   */
  async getServerInfo(): Promise<ServerInfo> {
    const response = await this.request<ServerInfo>('GET', '/1.0');
    return response.metadata;
  }

  /**
   * List all containers/instances
   */
  async listContainers(): Promise<string[]> {
    const response = await this.request<string[]>('GET', '/1.0/instances');
    return response.metadata;
  }

  /**
   * Get container details
   */
  async getContainer(name: string): Promise<Container> {
    const response = await this.request<Container>('GET', `/1.0/instances/${name}`);
    return response.metadata;
  }

  /**
   * Get container state (CPU, memory, network, etc.)
   */
  async getContainerState(name: string): Promise<ContainerState> {
    const response = await this.request<ContainerState>('GET', `/1.0/instances/${name}/state`);
    return response.metadata;
  }

  /**
   * Start a container
   */
  async startContainer(name: string): Promise<void> {
    await this.request('PUT', `/1.0/instances/${name}/state`, {
      action: 'start',
    });
  }

  /**
   * Stop a container
   */
  async stopContainer(name: string, force = false): Promise<void> {
    await this.request('PUT', `/1.0/instances/${name}/state`, {
      action: 'stop',
      force,
    });
  }

  /**
   * Restart a container
   */
  async restartContainer(name: string, force = false): Promise<void> {
    await this.request('PUT', `/1.0/instances/${name}/state`, {
      action: 'restart',
      force,
    });
  }

  /**
   * Create a new container
   */
  async createContainer(
    name: string,
    image: string,
    config?: Record<string, string>,
    devices?: Record<string, Record<string, string>>
  ): Promise<void> {
    await this.request('POST', '/1.0/instances', {
      name,
      source: {
        type: 'image',
        alias: image,
      },
      config,
      devices,
    });
  }

  /**
   * Delete a container
   */
  async deleteContainer(name: string): Promise<void> {
    await this.request('DELETE', `/1.0/instances/${name}`);
  }

  /**
   * Execute a command in a container
   */
  async execCommand(
    name: string,
    command: string[],
    options?: {
      environment?: Record<string, string>;
      user?: number;
      group?: number;
      cwd?: string;
    }
  ): Promise<{ stdout: string; stderr: string; return_code: number }> {
    const response = await this.request<{
      output: { stdout: string; stderr: string };
      return: number;
    }>('POST', `/1.0/instances/${name}/exec`, {
      command,
      'wait-for-websocket': false,
      'record-output': true,
      ...options,
    });
    
    return {
      stdout: response.metadata.output?.stdout || '',
      stderr: response.metadata.output?.stderr || '',
      return_code: response.metadata.return || 0,
    };
  }

  /**
   * Get list of images
   */
  async listImages(): Promise<string[]> {
    const response = await this.request<string[]>('GET', '/1.0/images');
    return response.metadata;
  }

  /**
   * Get list of profiles
   */
  async listProfiles(): Promise<string[]> {
    const response = await this.request<string[]>('GET', '/1.0/profiles');
    return response.metadata;
  }

  /**
   * Get list of networks
   */
  async listNetworks(): Promise<string[]> {
    const response = await this.request<string[]>('GET', '/1.0/networks');
    return response.metadata;
  }

  /**
   * Get list of storage pools
   */
  async listStoragePools(): Promise<string[]> {
    const response = await this.request<string[]>('GET', '/1.0/storage-pools');
    return response.metadata;
  }
}

// Export types for use in other files
export type {
  IncusResponse,
  Container,
  ContainerState,
  ServerInfo,
};
