/**
 * List User Permissions API
 *
 * GET — Returns all permissions for the current user
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getAllUserPermissions } from "@/lib/db/queries/permissions";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rows = await getAllUserPermissions(session.userId);

  return NextResponse.json({
    permissions: rows.map((r) => ({
      id: r.id,
      appId: r.appId,
      permission: r.permission,
      granted: r.granted,
      grantType: r.grantType,
      grantedAt: r.grantedAt?.toISOString() ?? null,
    })),
  });
}
