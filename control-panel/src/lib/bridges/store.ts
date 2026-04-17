/**
 * Bridge Storage
 *
 * Stores app-to-app network bridge records on disk.
 * Bridges allow specific inter-container communication
 * that's otherwise blocked by default-deny ACLs.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';

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
  approvedBy: string;
  approvedAt: string;
  activatedAt?: string;
}

async function ensureDir(): Promise<void> {
  if (!existsSync(BRIDGES_DIR)) {
    await mkdir(BRIDGES_DIR, { recursive: true });
  }
}

export async function loadBridges(): Promise<Bridge[]> {
  await ensureDir();
  try {
    const data = await readFile(BRIDGES_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

export async function saveBridges(bridges: Bridge[]): Promise<void> {
  await ensureDir();
  await writeFile(BRIDGES_FILE, JSON.stringify(bridges, null, 2));
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
  const bridges = await loadBridges();
  const existing = bridges.findIndex(b => b.id === bridge.id);
  if (existing >= 0) {
    bridges[existing] = bridge;
  } else {
    bridges.push(bridge);
  }
  await saveBridges(bridges);
}

export async function updateBridge(id: string, updates: Partial<Bridge>): Promise<Bridge | null> {
  const bridges = await loadBridges();
  const idx = bridges.findIndex(b => b.id === id);
  if (idx < 0) return null;
  bridges[idx] = { ...bridges[idx], ...updates };
  await saveBridges(bridges);
  return bridges[idx];
}

export async function removeBridge(id: string): Promise<boolean> {
  const bridges = await loadBridges();
  const idx = bridges.findIndex(b => b.id === id);
  if (idx < 0) return false;
  bridges.splice(idx, 1);
  await saveBridges(bridges);
  return true;
}
