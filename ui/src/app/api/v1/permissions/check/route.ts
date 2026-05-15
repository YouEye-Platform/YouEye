/**
 * Permissions Check API
 *
 * GET — Check if an app has a specific permission
 * Query: ?permission=timeline:write&app_id=cinema
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { checkPermission } from "@/lib/db/queries/permissions";

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const permission = url.searchParams.get("permission");
  const appId = url.searchParams.get("app_id");

  if (!permission || !appId) {
    return NextResponse.json(
      { error: "permission and app_id query params are required" },
      { status: 400 }
    );
  }

  const granted = await checkPermission(session.userId, appId, permission);

  return NextResponse.json({ permission, app_id: appId, granted });
}
