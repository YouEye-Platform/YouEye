/**
 * Runtime status bridge for Control Panel app power actions.
 */

import { NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { getApp, updateAppStatus } from "@/lib/db/queries/app-management";

const ALLOWED = new Set(["healthy", "unhealthy", "unknown", "stopped"]);

function validateBridgeAuth(request: Request): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token") ?? request.headers.get("x-ui-bridge-token");
  const expected = getBridgeToken();
  return !!provided && expected !== null && provided === expected;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ appId: string }> },
) {
  if (!validateBridgeAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { appId } = await params;
  const body = await request.json().catch(() => ({}));
  const status = typeof body.status === "string" ? body.status : "";
  if (!ALLOWED.has(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const app = await getApp(appId);
  if (!app) {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }

  await updateAppStatus(appId, status as "healthy" | "unhealthy" | "unknown" | "stopped");
  return NextResponse.json({ success: true, appId, status });
}
