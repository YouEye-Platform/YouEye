/**
 * Permission Request API
 *
 * POST — Request new permissions for an app
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { grantPermission } from "@/lib/db/queries/permissions";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { app_id, permissions, grant_type } = body;

  if (!app_id || !permissions || !Array.isArray(permissions)) {
    return NextResponse.json(
      { error: "app_id and permissions array are required" },
      { status: 400 }
    );
  }

  for (const perm of permissions) {
    await grantPermission(
      session.userId,
      app_id,
      perm,
      grant_type ?? "persistent",
      "user"
    );
  }

  return NextResponse.json({ success: true, granted: permissions });
}
