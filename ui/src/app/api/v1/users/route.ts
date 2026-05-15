/**
 * Users API
 *
 * GET /api/v1/users?role=admin — List admin users
 *
 * Authentication: X-UI-Bridge-Token (for Control Panel→UI system calls)
 * Used by the notification bridge to find admin user IDs for system notifications.
 */

import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { getAdminUsers } from "@/lib/db/queries/users";

function validateBridgeAuth(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function GET(request: NextRequest) {
  if (!validateBridgeAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = request.nextUrl.searchParams.get("role");

  if (role === "admin") {
    const admins = await getAdminUsers();
    return NextResponse.json({ users: admins });
  }

  // Only admin role is supported for now
  return NextResponse.json(
    { error: "Only role=admin is supported" },
    { status: 400 }
  );
}
