/**
 * Launcher Folders API — Plan 5.
 *
 * PUT /api/v1/apps/drawer/folders — replace the user's launcher folder set.
 * The client sends the full desired list (create/rename/delete in one call),
 * mirroring the drawer sections route. App→folder membership is set separately
 * via PUT /api/v1/apps/drawer/[appId] ({ folder_id }).
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateLauncherFolders } from "@/lib/db/queries/apps";

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json();

    if (!Array.isArray(body.folders)) {
      return NextResponse.json({ error: "Missing folders array" }, { status: 400 });
    }

    const folders = await updateLauncherFolders(
      session.userId,
      body.folders.map((f: { id: string; name: string; order?: number }) => ({
        id: f.id,
        name: f.name,
        order: f.order ?? 0,
      }))
    );

    return NextResponse.json({ folders });
  } catch {
    return NextResponse.json({ error: "Invalid folder data" }, { status: 400 });
  }
}
