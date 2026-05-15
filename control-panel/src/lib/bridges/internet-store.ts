/**
 * Internet Grants Store
 *
 * Stores per-app internet access grants in a JSON file.
 * Each grant specifies which hosts an app container can reach.
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const STORE_DIR = '/var/lib/youeye/bridges';
const STORE_FILE = join(STORE_DIR, 'internet-grants.json');

export interface InternetGrant {
  id: string;
  appId: string;
  containerName: string;
  hosts: string[];
  blanket: boolean;
  aclName: string;
  approvedBy: string;
  approvedAt: string;
  active: boolean;
}

async function readStore(): Promise<InternetGrant[]> {
  try {
    const raw = await readFile(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function writeStore(grants: InternetGrant[]): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(grants, null, 2));
}

export async function listInternetGrants(appId?: string): Promise<InternetGrant[]> {
  const grants = await readStore();
  if (appId) return grants.filter(g => g.appId === appId);
  return grants;
}

export async function getInternetGrant(id: string): Promise<InternetGrant | null> {
  const grants = await readStore();
  return grants.find(g => g.id === id) ?? null;
}

export async function createInternetGrant(grant: InternetGrant): Promise<void> {
  const grants = await readStore();
  // Replace existing grant for same app
  const idx = grants.findIndex(g => g.appId === grant.appId);
  if (idx >= 0) {
    grants[idx] = grant;
  } else {
    grants.push(grant);
  }
  await writeStore(grants);
}

export async function deleteInternetGrant(id: string): Promise<InternetGrant | null> {
  const grants = await readStore();
  const idx = grants.findIndex(g => g.id === id);
  if (idx < 0) return null;
  const [removed] = grants.splice(idx, 1);
  await writeStore(grants);
  return removed;
}
