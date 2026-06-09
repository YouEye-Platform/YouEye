/**
 * App Launch Requirements API
 *
 * GET — Resolve manifest-declared first-launch permission requirements.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getApp } from "@/lib/db/queries/app-management";
import { checkPermission } from "@/lib/db/queries/permissions";
import {
  buildPermissionApproval,
  normalizePermissionAppId,
  permissionAppMatches,
} from "@/lib/permissions/approval";
import { describePermission } from "@/lib/permissions/descriptors";
import { normalizeAppSurfaces } from "@/lib/surfaces/normalize";

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function collectLaunchPermissions(manifest: Record<string, unknown> | null): string[] {
  const permissions = new Set<string>();
  for (const permission of stringArray(manifest?.permissions)) {
    permissions.add(permission);
  }
  for (const surface of normalizeAppSurfaces(manifest)) {
    for (const permission of surface.permissions) {
      permissions.add(permission);
    }
  }
  return [...permissions].sort();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  const serviceUser = session ? null : await resolveServiceAuth(request);
  if (!session && !serviceUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const serviceAppId = request.headers.get("x-youeye-app");
  if (serviceUser && serviceAppId && !permissionAppMatches(appId, serviceAppId)) {
    return NextResponse.json(
      { error: "service app cannot inspect launch requirements for another app" },
      { status: 403 }
    );
  }

  const manifestAppId = normalizePermissionAppId(serviceUser && serviceAppId ? serviceAppId : appId);
  const grantAppId = serviceUser && serviceAppId ? serviceAppId : appId;
  const app = await getApp(manifestAppId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  const manifest = (app.manifest as Record<string, unknown> | null) ?? null;
  const required = collectLaunchPermissions(manifest);
  const userId = (session?.userId ?? serviceUser?.id)!;
  const checks = await Promise.all(
    required.map(async (permission) => ({
      permission,
      granted: await checkPermission(userId, grantAppId, permission),
    }))
  );
  const missing = checks.filter((check) => !check.granted).map((check) => check.permission);

  if (missing.length > 0) {
    return NextResponse.json(
      {
        first_launch_complete: false,
        app_id: grantAppId,
        manifest_app_id: app.id,
        required_permissions: required.map((permission) => describePermission(permission)),
        granted_permissions: checks
          .filter((check) => check.granted)
          .map((check) => describePermission(check.permission)),
        ...buildPermissionApproval(grantAppId, missing, "persistent", request),
      },
      { status: 202 }
    );
  }

  return NextResponse.json({
    success: true,
    first_launch_complete: true,
    app_id: grantAppId,
    manifest_app_id: app.id,
    required_permissions: required.map((permission) => describePermission(permission)),
    granted_permissions: required.map((permission) => describePermission(permission)),
    missing_permissions: [],
  });
}
