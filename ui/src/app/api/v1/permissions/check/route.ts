/**
 * Permissions Check API
 *
 * GET — Check if an app has a specific permission
 * Query: ?permission=timeline:write&app_id=cinema
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { checkPermission } from "@/lib/db/queries/permissions";
import { permissionAppMatches } from "@/lib/permissions/approval";

export async function GET(request: NextRequest) {
  const session = await getSession();
  const serviceUser = session ? null : await resolveServiceAuth(request);
  if (!session && !serviceUser) {
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

  const serviceAppId = request.headers.get("x-youeye-app");
  if (serviceUser && serviceAppId && !permissionAppMatches(appId, serviceAppId)) {
    return NextResponse.json(
      { error: "service app cannot check permissions for another app" },
      { status: 403 }
    );
  }
  const targetAppId = serviceUser && serviceAppId ? serviceAppId : appId;

  const granted = await checkPermission((session?.userId ?? serviceUser?.id)!, targetAppId, permission);

  return NextResponse.json({ permission, app_id: targetAppId, granted });
}
