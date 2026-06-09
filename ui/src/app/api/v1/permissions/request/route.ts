/**
 * Permission Request API
 *
 * POST — Request new permissions for an app
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { grantPermission } from "@/lib/db/queries/permissions";
import { describePermission } from "@/lib/permissions/descriptors";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
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

  const requested = permissions
    .filter((permission: unknown): permission is string => typeof permission === "string")
    .filter((permission: string) => permission.length > 0);

  if (requested.length === 0) {
    return NextResponse.json(
      { error: "permissions must contain at least one permission string" },
      { status: 400 }
    );
  }

  const descriptors = requested.map((permission: string) => describePermission(permission));

  if (approved !== true) {
    const params = new URLSearchParams();
    params.set("app_id", app_id);
    for (const permission of requested) params.append("permission", permission);
    if (typeof grant_type === "string" && grant_type.length > 0) params.set("grant_type", grant_type);

    return NextResponse.json({
      success: false,
      approval_required: true,
      app_id,
      requested: requested,
      permissions: descriptors,
      approval_url: `/permissions/approve?${params.toString()}`,
    }, { status: 202 });
  }

  for (const perm of requested) {
    await grantPermission(
      session.userId,
      app_id,
      perm,
      typeof grant_type === "string" && grant_type.length > 0 ? grant_type : "persistent",
      "user"
    );
  }

  return NextResponse.json({
    success: true,
    granted: requested,
    permissions: descriptors,
  });
}
