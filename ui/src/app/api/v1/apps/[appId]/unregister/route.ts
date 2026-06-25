/**
 * App Unregister API
 *
 * DELETE /api/v1/apps/[appId]/unregister — Remove a native app from YE-UI
 * Used by the Control Panel during native app uninstall to clean up dashboard state.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { unregisterApp } from "@/lib/db/queries/app-management";

function validateBridgeAuth(request: Request): boolean {
  const provided =
    request.headers.get("X-UI-Bridge-Token") ??
    request.headers.get("x-ui-bridge-token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;

  const isBridgeAuth = validateBridgeAuth(request);

  if (!isBridgeAuth) {
    const session = await getSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!session.isAdmin) {
      return NextResponse.json({ error: "Admin required" }, { status: 403 });
    }
  }

  await unregisterApp(appId);

  return NextResponse.json({ success: true, app_id: appId });
}
