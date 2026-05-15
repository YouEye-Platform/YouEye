/**
 * App Permissions API
 *
 * GET — List all permissions for a specific app
 * DELETE — Revoke a specific permission
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getAppPermissions,
  revokePermission,
} from "@/lib/db/queries/permissions";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const permissions = await getAppPermissions(session.userId, appId);

  return NextResponse.json({ app_id: appId, permissions });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;

  // Accept permission from query param OR JSON body
  const url = new URL(request.url);
  let permission = url.searchParams.get("permission");

  if (!permission) {
    try {
      const body = await request.json();
      permission = body.permission ?? null;
    } catch {
      // No body or invalid JSON
    }
  }

  if (!permission) {
    // Revoke ALL permissions for this app
    const perms = await getAppPermissions(session.userId, appId);
    for (const p of perms) {
      await revokePermission(session.userId, appId, p.permission);
    }
    return NextResponse.json({ success: true, revoked: perms.length });
  }

  await revokePermission(session.userId, appId, permission);

  return NextResponse.json({ success: true });
}
