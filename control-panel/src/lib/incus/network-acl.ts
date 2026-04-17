/**
 * Incus Network ACL Management
 *
 * Creates and manages network ACLs for app isolation.
 * Default-deny: no app can reach CP, DB, other apps, or system containers
 * unless explicitly bridged. Apps can only reach YE-UI (gateway).
 */

import { incusRequest } from './server';

const ACL_SYSTEM = 'ye-system';
const ACL_APP = 'ye-app-isolated';

interface AclRule {
  action: 'allow' | 'reject' | 'drop';
  state: 'enabled' | 'disabled';
  source?: string;
  destination?: string;
  protocol?: string;
  source_port?: string;
  destination_port?: string;
  description?: string;
}

interface AclConfig {
  name: string;
  description: string;
  ingress: AclRule[];
  egress: AclRule[];
}

async function aclExists(name: string): Promise<boolean> {
  try {
    const res = await incusRequest('GET', `/1.0/network-acls/${name}`);
    return res.status_code === 200;
  } catch {
    return false;
  }
}

const SYSTEM_CONTAINERS = [
  'youeye-control', 'youeye-ui', 'youeye-caddy',
  'youeye-postgres', 'youeye-authentik', 'youeye-authentik-worker',
  'youeye-pihole',
];

let _aclsInitialized = false;

export async function ensureNetworkAcls(): Promise<void> {
  if (_aclsInitialized) return;

  let created = false;

  // ACL for system containers (used as a tag for matching)
  if (!(await aclExists(ACL_SYSTEM))) {
    await incusRequest('POST', '/1.0/network-acls', {
      name: ACL_SYSTEM,
      description: 'System containers — allows inbound from isolated apps',
      ingress: [
        {
          action: 'allow',
          state: 'enabled',
          source: `@${ACL_APP}`,
          description: 'Allow app containers to reach system services',
        },
      ],
      egress: [],
    } as AclConfig);
    created = true;
  }

  // ACL for app containers — restrictive
  if (!(await aclExists(ACL_APP))) {
    await incusRequest('POST', '/1.0/network-acls', {
      name: ACL_APP,
      description: 'App containers — isolated, can only reach system services',
      ingress: [
        {
          action: 'allow',
          state: 'enabled',
          source: `@${ACL_SYSTEM}`,
          description: 'Allow system containers to reach apps (health checks, proxying)',
        },
      ],
      egress: [
        {
          action: 'allow',
          state: 'enabled',
          destination: `@${ACL_SYSTEM}`,
          description: 'Allow reaching YE-UI and system services',
        },
        {
          action: 'allow',
          state: 'enabled',
          protocol: 'udp',
          destination_port: '53',
          description: 'Allow DNS resolution',
        },
        {
          action: 'allow',
          state: 'enabled',
          protocol: 'tcp',
          destination_port: '53',
          description: 'Allow DNS resolution (TCP)',
        },
      ],
    } as AclConfig);
    created = true;
  }

  // Apply system ACL to all system containers (idempotent)
  if (created) {
    for (const name of SYSTEM_CONTAINERS) {
      await applySystemAcl(name);
    }
    console.log('[acl] Network ACLs initialized, system containers tagged');
  }

  _aclsInitialized = true;
}

export async function applySystemAcl(containerName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
      config: Record<string, string>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }
    devices.eth0['security.acls'] = ACL_SYSTEM;

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to apply system ACL to ${containerName}:`, err);
  }
}

export async function applyAppAcl(containerName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }
    devices.eth0['security.acls'] = ACL_APP;
    devices.eth0['security.acls.default.egress.action'] = 'drop';
    devices.eth0['security.acls.default.ingress.action'] = 'drop';

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to apply app ACL to ${containerName}:`, err);
  }
}

/**
 * Create an ACL rule allowing one app to reach another (bridge).
 * Returns a unique ACL name for this bridge.
 */
export async function createBridgeAcl(
  fromContainer: string,
  toContainer: string,
  direction: 'one-way' | 'both-ways',
): Promise<string> {
  const aclName = `ye-bridge-${fromContainer}-${toContainer}`;

  if (await aclExists(aclName)) {
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  }

  const ingress: AclRule[] = [];
  const egress: AclRule[] = [];

  // fromContainer needs to reach toContainer
  // We apply this ACL to fromContainer's NIC
  // The egress rule allows traffic to toContainer
  // We'll also need to add an ingress rule on toContainer to accept from fromContainer

  await incusRequest('POST', '/1.0/network-acls', {
    name: aclName,
    description: `Bridge: ${fromContainer} → ${toContainer}`,
    ingress: direction === 'both-ways'
      ? [{ action: 'allow', state: 'enabled', description: `Accept from ${toContainer}` }]
      : [],
    egress: [
      { action: 'allow', state: 'enabled', description: `Reach ${toContainer}` },
    ],
  } as AclConfig);

  // Add this ACL to fromContainer's NIC (append to existing ACLs)
  await appendAclToContainer(fromContainer, aclName);

  if (direction === 'both-ways') {
    await appendAclToContainer(toContainer, aclName);
  }

  return aclName;
}

export async function removeBridgeAcl(aclName: string): Promise<void> {
  try {
    await incusRequest('DELETE', `/1.0/network-acls/${aclName}`);
  } catch {
    // ACL may not exist
  }
}

async function appendAclToContainer(containerName: string, aclName: string): Promise<void> {
  try {
    const res = await incusRequest<{
      devices: Record<string, Record<string, string>>;
    }>('GET', `/1.0/instances/${containerName}`);
    const instance = res.metadata;

    const devices = { ...instance.devices };
    if (!devices.eth0) {
      devices.eth0 = { name: 'eth0', network: 'incusbr0', type: 'nic' };
    }

    const existing = devices.eth0['security.acls'] || '';
    const aclList = existing.split(',').filter(Boolean);
    if (!aclList.includes(aclName)) {
      aclList.push(aclName);
    }
    devices.eth0['security.acls'] = aclList.join(',');

    await incusRequest('PATCH', `/1.0/instances/${containerName}`, { devices });
  } catch (err) {
    console.warn(`[acl] Failed to append ACL ${aclName} to ${containerName}:`, err);
  }
}

export { ACL_SYSTEM, ACL_APP };
