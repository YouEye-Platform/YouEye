/**
 * Permission Request API
 *
 * POST — Request new permissions for an app
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { grantPermission } from "@/lib/db/queries/permissions";
import {
  buildPermissionApproval,
  permissionAppMatches,
} from "@/lib/permissions/approval";

export async function POST(request: NextRequest) {
  const session = await getSession();
  const serviceUser = session ? null : await resolveServiceAuth(request);
  if (!session && !serviceUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { app_id, permissions, grant_type, approved } = body;

  if (typeof app_id !== "string" || app_id.length === 0 || !permissions || !Array.isArray(permissions)) {
    return NextResponse.json(
      { error: "app_id and permissions array are required" },
      { status: 400 }
    );
  }

  const serviceAppId = request.headers.get("x-youeye-app");
  if (serviceUser && serviceAppId && !permissionAppMatches(app_id, serviceAppId)) {
    return NextResponse.json(
      { error: "service app cannot request permissions for another app" },
      { status: 403 }
    );
  }
  const targetAppId = serviceUser && serviceAppId ? serviceAppId : app_id;

  const requested = permissions
    .filter((permission: unknown): permission is string => typeof permission === "string")
    .filter((permission: string) => permission.length > 0);

  if (requested.length === 0) {
    return NextResponse.json(
      { error: "permissions must contain at least one permission string" },
      { status: 400 }
    );
  }

  const approval = buildPermissionApproval(targetAppId, requested, grant_type, request);

  if (approved !== true || !session) {
    return NextResponse.json(approval, { status: 202 });
  }

  for (const perm of requested) {
    await grantPermission(
      session.userId,
      targetAppId,
      perm,
      typeof grant_type === "string" && grant_type.length > 0 ? grant_type : "persistent",
      "user"
    );
  }

  return NextResponse.json({
    success: true,
    granted: requested,
    permissions: approval.permissions,
  });
}
