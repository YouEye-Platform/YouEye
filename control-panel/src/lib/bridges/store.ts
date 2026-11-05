/**
 * Bridge Storage
 *
 * Stores app-to-app network bridge records on disk.
 * Bridges allow specific inter-container communication
 * that's otherwise blocked by default-deny ACLs.
 */

import { chmod, lstat, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { writeJsonAtomically } from './atomic-json-store';
import { withAppNetworkOperationLock } from '../incus/app-network-ipam';

const BRIDGES_DIR = '/var/lib/youeye/bridges';
const BRIDGES_FILE = `${BRIDGES_DIR}/bridges.json`;

export interface EnvMapping {
  container: string;
  key: string;
  template: string;
  resolved?: string;
}

export interface Bridge {
  id: string;
  from: string;
  to: string;
  direction: 'one-way' | 'both-ways';
  approved: boolean;
  active: boolean;
  envMappings: EnvMapping[];
  aclName?: string;
  accessMode?: 'network' | 'proxy' | 'caddy';
  url?: string;
  allowedPaths?: string[];
  allowedMethods?: string[];
  approvedBy: string;
  approvedAt: string;
  activatedAt?: string;
}

async function ensureDir(): Promise<void> {
  if (!existsSync(BRIDGES_DIR)) {
    await mkdir(BRIDGES_DIR, { recursive: true, mode: 0o700 });
  }
  const directory = await lstat(BRIDGES_DIR);
  if (!directory.isDirectory()) throw new Error('Bridge store directory is not a real directory');
  await chmod(BRIDGES_DIR, 0o700);
}

function validateBridge(value: unknown, index: number): Bridge {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bridge record ${index} must be an object`);
  }
  const bridge = value as Partial<Bridge>;
  const validAppId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(candidate);
  if (!validAppId(bridge.from) || !validAppId(bridge.to) || bridge.from === bridge.to
    || bridge.id !== `${bridge.from}-to-${bridge.to}`
    || !['one-way', 'both-ways'].includes(String(bridge.direction))
    || typeof bridge.approved !== 'boolean' || typeof bridge.active !== 'boolean'
    || !Array.isArray(bridge.envMappings) || typeof bridge.approvedBy !== 'string'
    || typeof bridge.approvedAt !== 'string') {
    throw new Error(`Bridge record ${index} is invalid`);
  }
  for (const mapping of bridge.envMappings) {
    if (!mapping || typeof mapping !== 'object' || typeof mapping.container !== 'string'
      || typeof mapping.key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(mapping.key)
      || typeof mapping.template !== 'string'
      || (mapping.resolved !== undefined
        && (typeof mapping.resolved !== 'string' || /[\r\n\0]/.test(mapping.resolved)))) {
      throw new Error(`Bridge record ${index} contains an invalid environment mapping`);
    }
  }
  return bridge as Bridge;
}

export async function loadBridges(): Promise<Bridge[]> {
  await ensureDir();
  try {
    const file = await lstat(BRIDGES_FILE);
    if (!file.isFile()) throw new Error('Bridge store is not a regular file');
    await chmod(BRIDGES_FILE, 0o600);
    const data = await readFile(BRIDGES_FILE, 'utf-8');
    const parsed: unknown = JSON.parse(data);
    if (!Array.isArray(parsed)) throw new Error('Bridge store must contain an array');
    const bridges = parsed.map(validateBridge);
    if (new Set(bridges.map((bridge) => bridge.id)).size !== bridges.length) {
      throw new Error('Bridge store contains duplicate records');
    }
    return bridges;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error('Bridge store is corrupt or insecure');
  }
}

export async function saveBridges(bridges: Bridge[]): Promise<void> {
  await ensureDir();
  await writeJsonAtomically(BRIDGES_FILE, bridges);
}

export async function getBridge(id: string): Promise<Bridge | null> {
  const bridges = await loadBridges();
  return bridges.find(b => b.id === id) ?? null;
}

export async function getBridgesForApp(appId: string): Promise<Bridge[]> {
  const bridges = await loadBridges();
  return bridges.filter(b => b.from === appId || b.to === appId);
}

export async function getPendingBridgesForTarget(targetAppId: string): Promise<Bridge[]> {
  const bridges = await loadBridges();
  return bridges.filter(b => b.to === targetAppId && b.approved && !b.active);
}

export async function addBridge(bridge: Bridge): Promise<void> {
  await withAppNetworkOperationLock('bridge-store', 'bridge-add', async () => {
    validateBridge(bridge, 0);
    const bridges = await loadBridges();
    const existing = bridges.findIndex(b => b.id === bridge.id);
    if (existing >= 0) {
      bridges[existing] = bridge;
    } else {
      bridges.push(bridge);
    }
    await saveBridges(bridges);
  }, { waitMs: 30_000 });
}

export async function updateBridge(id: string, updates: Partial<Bridge>): Promise<Bridge | null> {
  return withAppNetworkOperationLock('bridge-store', 'bridge-update', async () => {
    const bridges = await loadBridges();
    const idx = bridges.findIndex(b => b.id === id);
    if (idx < 0) return null;
    const updated = { ...bridges[idx], ...updates };
    validateBridge(updated, idx);
    bridges[idx] = updated;
    await saveBridges(bridges);
    return updated;
  }, { waitMs: 30_000 });
}

export async function removeBridge(id: string): Promise<boolean> {
  return withAppNetworkOperationLock('bridge-store', 'bridge-remove', async () => {
    const bridges = await loadBridges();
    const idx = bridges.findIndex(b => b.id === id);
    if (idx < 0) return false;
    bridges.splice(idx, 1);
    await saveBridges(bridges);
    return true;
  }, { waitMs: 30_000 });
}
