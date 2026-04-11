/**
 * Admin Bridge API Types
 *
 * Type definitions for the Control Panel bridge API responses.
 * These match the contract defined by the CP-side bridge endpoints.
 */

/** GET /api/admin/system */
export interface SystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  uptime: string;
  cpu: { cores: number; model: string };
  memory: { total_mb: number; used_mb: number; free_mb: number };
  disk: { total_gb: number; used_gb: number; free_gb: number };
  incus: { version: string; storage_pool: string };
  containers: { total: number; running: number; stopped: number };
}

/** GET /api/admin/containers */
export interface ContainerList {
  containers: ContainerInfo[];
}

export interface ContainerInfo {
  name: string;
  status: "Running" | "Stopped" | "Error";
  type: string;
  ipv4: string | null;
  created_at: string;
  profiles: string[];
}

/** POST /api/admin/containers/[name]/action */
export interface ContainerActionRequest {
  action: "start" | "stop" | "restart";
}

export interface ContainerActionResponse {
  success: boolean;
  error?: string;
}

/** GET /api/admin/dns/stats */
export interface DnsStats {
  status: "enabled" | "disabled";
  queries_today: number;
  blocked_today: number;
  percent_blocked: number;
  top_queries: Array<{ domain: string; count: number }>;
  top_blocked: Array<{ domain: string; count: number }>;
  gravity_size: number;
}

/** POST /api/admin/dns/control */
export interface DnsControlRequest {
  action: "enable" | "disable";
}

export interface DnsControlResponse {
  success: boolean;
  status: "enabled" | "disabled";
}

/** GET /api/admin/proxy/routes */
export interface ProxyRoutes {
  routes: ProxyRoute[];
}

export interface ProxyRoute {
  id: string;
  match_domain: string;
  upstream: string;
  tls_enabled: boolean;
}

/** GET /api/admin/users */
export interface UserList {
  users: UserInfo[];
}

export interface UserInfo {
  id: number;
  username: string;
  name: string;
  email: string;
  is_active: boolean;
  is_superuser: boolean;
  last_login: string | null;
  type?: string;
  path?: string;
}

/** GET /api/admin/updates */
export interface UpdateInfo {
  components: Array<{
    name: string;
    current_version: string;
    latest_version: string;
    update_available: boolean;
    repo: string;
  }>;
}

/** GET /api/admin/updates/status */
export interface UpdateStatusRecord {
  component: string;
  status: string;
  progress: number;
  message: string;
  version_before: string | null;
  version_after: string | null;
  error: string | null;
  started_at: string | null;
  updated_at: string;
}

export interface UpdateStatusResponse {
  statuses: UpdateStatusRecord[];
}

/** GET /api/admin/config */
export interface PlatformConfig {
  cpUrl: string;
  domain: string;
}
