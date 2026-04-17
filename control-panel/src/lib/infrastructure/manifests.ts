/**
 * Infrastructure app manifests — ported from Spine's Go manifest.go
 * Defines all OCI and LXD apps deployed during `spine deploy`.
 */

import { OCIManifest, LXDContainerSpec } from './types';

export function caddyManifest(): OCIManifest {
  return {
    name: 'caddy',
    displayName: 'Caddy',
    image: 'docker.io/library/caddy',
    containerName: 'youeye-caddy',
    // --resume: auto-loads last config pushed via Admin API (saved to /config/caddy/autosave.json).
    // Falls back to default Caddyfile on first boot.
    // Both /data (TLS certs) and /config (autosave) are persisted on the host
    // so configuration survives container recreation (incus rebuild / redeploy).
    command: 'caddy run --config /etc/caddy/Caddyfile --adapter caddyfile --resume',
    ports: [
      { host: 80, container: 80, protocol: 'tcp' },
      { host: 443, container: 443, protocol: 'tcp' },
      // Admin API (2019) NOT exposed to host — CP accesses via container network
    ],
    environment: {
      // Bind admin API to all interfaces inside container so CP
      // can reach it via container network (youeye-caddy.youeye:2019)
      CADDY_ADMIN: '0.0.0.0:2019',
    },
    volumes: [
      // /data persists TLS certificates across container recreation
      { host: '/var/lib/youeye/caddy/data', container: '/data' },
      // /config persists autosave.json (Caddy's --resume config) across container recreation.
      // Without this, container recreation loses the API-pushed config and Caddy falls back
      // to the default Caddyfile (:80 file_server), breaking HTTPS.
      { host: '/var/lib/youeye/caddy/config', container: '/config' },
    ],
  };
}

export function piholeManifest(hostIP: string): OCIManifest {
  return {
    name: 'pihole',
    displayName: 'Pi-Hole',
    image: 'docker.io/pihole/pihole:latest',
    containerName: 'youeye-pihole',
    ports: [
      { host: 53, container: 53, protocol: 'tcp' },
      { host: 53, container: 53, protocol: 'udp' },
      // Web UI (port 80) NOT exposed — access via Caddy subdomain route
    ],
    environment: {
      TZ: 'America/New_York',
      // Do NOT set FTLCONF_webserver_api_password here. When that env var
      // is present, FTL v6 treats it as the permanent password override and
      // locks out `pihole setpassword` entirely (exits with code 5:
      // "set by environment variable"). This makes password changes through
      // CP impossible and breaks the resync recovery path. Instead, the
      // deployer calls `pihole setpassword` after the container is healthy
      // (see deployer.ts step 7).
      FTLCONF_dns_listeningMode: 'all',
      FTLCONF_webserver_port: '80',
    },
    volumes: [
      { host: '/var/lib/youeye/pihole/etc', container: '/etc/pihole' },
      { host: '/var/lib/youeye/pihole/dnsmasq', container: '/etc/dnsmasq.d' },
    ],
    // CRITICAL: pihole's port-53 proxy device is bound to the host's primary
    // LAN IP (see oci-deployer.ts:125-127). If the host's IP changes between
    // boots and Incus tries to autostart this container with the stale listen
    // address, the proxy device fails to bind and the container ends up in a
    // wedged state where every subsequent Incus operation against it hangs
    // forever — only a host reboot recovers it. So we explicitly disable
    // autostart for pihole and let Spine's host-IP-check goroutine start
    // it after verifying/fixing the proxy device on a stopped container.
    autostart: false,
  };
}

export function postgresManifest(password: string): OCIManifest {
  return {
    name: 'postgres',
    displayName: 'PostgreSQL',
    image: 'docker.io/library/postgres:17-alpine',
    containerName: 'youeye-postgres',
    ports: [], // Internal only — no host exposure
    environment: {
      POSTGRES_USER: 'youeye',
      POSTGRES_DB: 'youeye',
      POSTGRES_PASSWORD: password,
      PGDATA: '/var/lib/postgresql/data',
    },
    volumes: [
      { host: '/var/lib/youeye/postgres/data', container: '/var/lib/postgresql/data' },
    ],
  };
}

export function authentikServerManifest(
  postgresIP: string,
  dbPassword: string,
  secretKey: string,
  bootstrapPassword: string,
  bootstrapToken: string
): OCIManifest {
  return {
    name: 'authentik',
    displayName: 'Authentik',
    image: 'ghcr.io/goauthentik/server:2025.12',
    containerName: 'youeye-authentik',
    command: 'dumb-init -- ak server',
    ports: [], // Internal only — accessed via Caddy
    environment: {
      AUTHENTIK_POSTGRESQL__HOST: postgresIP,
      AUTHENTIK_POSTGRESQL__PORT: '5432',
      AUTHENTIK_POSTGRESQL__USER: 'authentik',
      AUTHENTIK_POSTGRESQL__PASSWORD: dbPassword,
      AUTHENTIK_POSTGRESQL__NAME: 'authentik',
      AUTHENTIK_SECRET_KEY: secretKey,
      AUTHENTIK_BOOTSTRAP_PASSWORD: bootstrapPassword,
      AUTHENTIK_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTHENTIK_BOOTSTRAP_EMAIL: 'admin@youeye.local',
      AUTHENTIK_LOG_LEVEL: 'info',
      AUTHENTIK_DISABLE_UPDATE_CHECK: 'true',
      'AUTHENTIK_ERROR_REPORTING__ENABLED': 'false',
    },
    volumes: [
      { host: '/var/lib/youeye/authentik/media', container: '/media' },
      { host: '/var/lib/youeye/authentik/templates', container: '/templates' },
    ],
  };
}

export function authentikWorkerManifest(
  postgresIP: string,
  dbPassword: string,
  secretKey: string,
  bootstrapPassword: string,
  bootstrapToken: string
): OCIManifest {
  return {
    name: 'authentik-worker',
    displayName: 'Authentik Worker',
    image: 'ghcr.io/goauthentik/server:2025.12',
    containerName: 'youeye-authentik-worker',
    command: 'dumb-init -- ak worker',
    ports: [],
    environment: {
      AUTHENTIK_POSTGRESQL__HOST: postgresIP,
      AUTHENTIK_POSTGRESQL__PORT: '5432',
      AUTHENTIK_POSTGRESQL__USER: 'authentik',
      AUTHENTIK_POSTGRESQL__PASSWORD: dbPassword,
      AUTHENTIK_POSTGRESQL__NAME: 'authentik',
      AUTHENTIK_SECRET_KEY: secretKey,
      AUTHENTIK_BOOTSTRAP_PASSWORD: bootstrapPassword,
      AUTHENTIK_BOOTSTRAP_TOKEN: bootstrapToken,
      AUTHENTIK_BOOTSTRAP_EMAIL: 'admin@youeye.local',
      AUTHENTIK_LOG_LEVEL: 'info',
      AUTHENTIK_DISABLE_UPDATE_CHECK: 'true',
      'AUTHENTIK_ERROR_REPORTING__ENABLED': 'false',
    },
    volumes: [
      { host: '/var/lib/youeye/authentik/media', container: '/media' },
      { host: '/var/lib/youeye/authentik/templates', container: '/templates' },
    ],
  };
}

export function uiContainerSpec(): LXDContainerSpec {
  return {
    name: 'ui',
    displayName: 'YouEye UI',
    containerName: 'youeye-ui',
    image: 'debian/12',
    imageServer: 'https://images.linuxcontainers.org',
    imageProtocol: 'simplestreams',
    nodeVersion: '22.x',
    appDir: '/opt/youeye-ui',
    port: 3000,
  };
}

export function connectorsContainerSpec(): LXDContainerSpec {
  return {
    name: 'connectors',
    displayName: 'Connector Runtime',
    containerName: 'youeye-connectors',
    image: 'debian/12',
    imageServer: 'https://images.linuxcontainers.org',
    imageProtocol: 'simplestreams',
    nodeVersion: '22.x',
    appDir: '/opt/youeye-connectors',
    port: 3001,
  };
}
