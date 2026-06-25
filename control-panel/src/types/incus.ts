/**
 * Incus API Types
 */

export interface NetworkAddress {
  family: string;
  address: string;
  netmask: string;
  scope: string;
}

export interface ContainerInfo {
  name: string;
  status: string;
  type: string;
  ipv4?: string;
  cpu?: number;
  memory?: {
    usage: number;
    total: number;
  };
  state?: {
    network?: Record<string, {
      addresses: NetworkAddress[];
    }>;
  };
}

export interface ServerInfo {
  server_name: string;
  server_version: string;
  os_name: string;
  os_version: string;
  kernel_version: string;
}

export interface IncusResponse<T> {
  type: string;
  status: string;
  status_code: number;
  operation?: string;
  error_code?: number;
  error?: string;
  metadata?: T;
}

export interface ContainerState {
  status: string;
  status_code: number;
  disk?: Record<string, { usage: number }>;
  memory?: {
    usage: number;
    usage_peak: number;
    total: number;
  };
  network?: Record<string, {
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
    state: string;
    type: string;
  }>;
  cpu?: {
    usage: number;
  };
}

export interface ContainerAction {
  action: 'start' | 'stop' | 'restart' | 'freeze' | 'unfreeze';
  force?: boolean;
  timeout?: number;
}
