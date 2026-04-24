/**
 * Internet Grants API
 *
 * GET  /api/internet-grants?appId=  — list grants (optionally filtered)
 * POST /api/internet-grants         — create a grant
 *
 * Per-app bridge apps: toggles NAT on the bridge (ipv4.nat=true)
 * Legacy apps (incusbr0): creates ACL rules (deprecated)
 */

import { NextResponse } from 'next/server';
import {
  listInternetGrants,
  createInternetGrant,
  type InternetGrant,
} from '@/lib/bridges/internet-store';
import { grantInternetAccess } from '@/lib/incus/network-acl';
import { hasAppNetwork, setAppNetworkNAT } from '@/lib/incus/app-network';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const appId = url.searchParams.get('appId') ?? undefined;
  const grants = await listInternetGrants(appId);
  return NextResponse.json(grants);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { appId, containerName, hosts, blanket, approvedBy } = body;

  if (!appId || !containerName) {
    return NextResponse.json(
      { error: 'appId and containerName are required' },
      { status: 400 },
    );
  }

  const hostList = hosts ?? [];
  const isBlanket = blanket ?? false;
  let aclName = '';

  // Per-app bridge: toggle NAT on the bridge
  if (await hasAppNetwork(appId)) {
    await setAppNetworkNAT(appId, true);
  } else {
    // Legacy: ACL-based internet grant
    aclName = await grantInternetAccess(containerName, hostList, isBlanket);
  }

  const grant: InternetGrant = {
    id: `internet-${appId}`,
    appId,
    containerName,
    hosts: hostList,
    blanket: isBlanket,
    aclName,
    approvedBy: approvedBy ?? 'admin',
    approvedAt: new Date().toISOString(),
    active: true,
  };

  await createInternetGrant(grant);
  return NextResponse.json(grant, { status: 201 });
}
