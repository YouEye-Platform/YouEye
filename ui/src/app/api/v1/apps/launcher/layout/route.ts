/**
 * Full-screen launcher layout API.
 *
 * PUT replaces the authenticated user's complete app order, folder set, and
 * membership atomically. The launcher is an all-app surface, so the submitted
 * app set must match the server's current enabled + platform app set.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserAppsWithConfig, updateLauncherLayout } from "@/lib/db/queries/apps";

interface FolderInput {
  id: string;
  name: string;
  order: number;
}

interface LayoutInput {
  id: string;
  folder_id: string | null;
  order: number;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function isOrder(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 10_000;
}

export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json();
    if (!Array.isArray(body.folders) || !Array.isArray(body.layout)) {
      return NextResponse.json({ error: "Missing launcher layout" }, { status: 400 });
    }
    if (body.folders.length > 100 || body.layout.length > 500) {
      return NextResponse.json({ error: "Launcher layout is too large" }, { status: 400 });
    }

    const folders: FolderInput[] = body.folders;
    const layout: LayoutInput[] = body.layout;
    const folderIds = new Set<string>();
    for (const folder of folders) {
      if (!folder || typeof folder.id !== "string" || !SAFE_ID.test(folder.id)
        || typeof folder.name !== "string" || folder.name.trim().length < 1
        || folder.name.trim().length > 80 || !isOrder(folder.order)
        || folderIds.has(folder.id)) {
        return NextResponse.json({ error: "Invalid launcher folder" }, { status: 400 });
      }
      folder.name = folder.name.trim();
      folderIds.add(folder.id);
    }

    const appIds = new Set<string>();
    for (const item of layout) {
      if (!item || typeof item.id !== "string" || !SAFE_ID.test(item.id)
        || (item.folder_id !== null && (typeof item.folder_id !== "string" || !folderIds.has(item.folder_id)))
        || !isOrder(item.order) || appIds.has(item.id)) {
        return NextResponse.json({ error: "Invalid launcher app layout" }, { status: 400 });
      }
      appIds.add(item.id);
    }

    const current = await getUserAppsWithConfig(session.userId);
    const currentIds = new Set(current.apps.map((app) => app.id));
    if (currentIds.size !== appIds.size || [...currentIds].some((id) => !appIds.has(id))) {
      return NextResponse.json({ error: "Apps changed; reload the launcher" }, { status: 409 });
    }
    const referencedFolders = new Set(layout.map((item) => item.folder_id).filter((id): id is string => id !== null));
    if ([...folderIds].some((id) => !referencedFolders.has(id))) {
      return NextResponse.json({ error: "Empty launcher folder" }, { status: 400 });
    }

    const result = await updateLauncherLayout(
      session.userId,
      folders,
      layout.map((item) => ({ id: item.id, folderId: item.folder_id, order: item.order })),
    );
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Invalid launcher layout" }, { status: 400 });
  }
}
