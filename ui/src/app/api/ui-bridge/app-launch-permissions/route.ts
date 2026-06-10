/**
 * UI Bridge — App launch permission preview/grant endpoint.
 *
 * Called by Control Panel's identity provider authorize page so the first-launch
 * identity consent can show runtime app permissions without CP owning them.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { getApp } from "@/lib/db/queries/app-management";
import { denyPermission, getPermissionDecision, grantPermission } from "@/lib/db/queries/permissions";
import { findUserByIdentityId, findUserByEmail, findUserById, findUserByUsername } from "@/lib/db/queries/users";
import { describePermission } from "@/lib/permissions/descriptors";
import { normalizeAppSurfaces } from "@/lib/surfaces/normalize";
import { collectInternetPermissions } from "@/lib/internet/scopes";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function collectManifestPermissions(manifest: Record<string, unknown> | null): string[] {
  const permissions = new Set<string>();
  for (const permission of stringArray(manifest?.permissions)) {
    permissions.add(permission);
  }
  for (const surface of normalizeAppSurfaces(manifest)) {
    for (const permission of surface.permissions) {
      permissions.add(permission);
    }
  }
  for (const permission of collectInternetPermissions(manifest)) {
    permissions.add(permission);
  }
  return [...permissions];
}

function collectConnectionPermissions(connections: Record<string, unknown> | null): string[] {
  const available = Array.isArray(connections?.available) ? connections.available : [];
  const permissions = new Set<string>();
  for (const item of available) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.installed !== true) continue;
    if (typeof record.appId !== "string" || record.appId.length === 0) continue;
    permissions.add(`connection:${record.appId.replace(/^app-/, "").replace(/^ye-/, "")}`);
  }
  return [...permissions];
}

async function permissionState(userId: string, appId: string) {
  const app = await getApp(appId);
  if (!app) {
    return { error: NextResponse.json({ error: `App "${appId}" not found` }, { status: 404 }) };
  }

  const manifest = (app.manifest as Record<string, unknown> | null) ?? null;
  const connections = (app.connections as Record<string, unknown> | null) ?? null;
  const required = Array.from(new Set([
    ...collectManifestPermissions(manifest),
    ...collectConnectionPermissions(connections),
  ])).sort();

  const checks = await Promise.all(required.map(async (permission) => ({
    permission,
    decision: await getPermissionDecision(userId, appId, permission),
  })));
  const missing = checks.filter((check) => check.decision === null).map((check) => check.permission);
  const denied = checks.filter((check) => check.decision === false).map((check) => check.permission);

  return {
    appId,
    required,
    missing,
    permissions: missing.map((permission) => describePermission(permission)),
    granted: checks.filter((check) => check.decision === true).map((check) => describePermission(check.permission)),
    denied: denied.map((permission) => describePermission(permission)),
  };
}

async function resolveUiUser(input: {
  identityUserId?: string;
  username?: string;
  email?: string;
}) {
  if (input.identityUserId) {
    const user = await findUserByIdentityId(input.identityUserId);
    if (user) return user;
    const legacyUser = await findUserById(input.identityUserId);
    if (legacyUser) return legacyUser;
  }
  if (input.username) {
    const user = await findUserByUsername(input.username);
    if (user) return user;
  }
  if (input.email) {
    const user = await findUserByEmail(input.email);
    if (user) return user;
  }
  return null;
}

export async function POST(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const appId = typeof body.appId === "string" ? body.appId.replace(/^ye-/, "") : "";
  const identityUserId = typeof body.identityUserId === "string"
    ? body.identityUserId
    : typeof body.userId === "string"
      ? body.userId
      : "";
  const username = typeof body.username === "string" ? body.username : "";
  const email = typeof body.email === "string" ? body.email : "";
  const selected = stringArray(body.grantPermissions);
  const denyUnselected = body.denyUnselected === true;

  if (!appId || (!identityUserId && !username && !email)) {
    return NextResponse.json({ error: "appId and a user identity are required" }, { status: 400 });
  }

  const user = await resolveUiUser({ identityUserId, username, email });
  if (!user) {
    return NextResponse.json({ error: "User not found in UI database" }, { status: 404 });
  }
  const userId = user.id;

  const before = await permissionState(userId, appId);
  if ("error" in before) return before.error;

  const allowed = new Set(before.missing);
  const toGrant = selected.filter((permission) => allowed.has(permission));
  const selectedSet = new Set(toGrant);
  const toDeny = denyUnselected
    ? before.missing.filter((permission) => !selectedSet.has(permission))
    : [];
  for (const permission of toGrant) {
    await grantPermission(userId, appId, permission, "persistent", "youeye-id-consent");
  }
  for (const permission of toDeny) {
    await denyPermission(userId, appId, permission, "youeye-id-consent");
  }

  const after = toGrant.length > 0 || toDeny.length > 0 ? await permissionState(userId, appId) : before;
  if ("error" in after) return after.error;

  return NextResponse.json({
    success: true,
    app_id: appId,
    required_permissions: after.required.map((permission) => describePermission(permission)),
    missing_permissions: after.missing,
    permissions: after.permissions,
    granted_permissions: after.granted,
    denied_permissions: after.denied,
  });
}
