/**
 * Single App Config API
 *
 * PUT /api/apps/drawer/[appId] — Update per-user app config
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { updateAppConfig } from "@/lib/db/queries/apps";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { appId } = await params;
    const body = await request.json();

    const updated = await updateAppConfig(session.userId, appId, {
      customName: body.custom_name,
      customIconUrl: body.custom_icon_url,
      visible: body.visible,
      displayOrder: body.order,
      sectionId: body.section_id,
    });

    return NextResponse.json(updated);
  } catch {
    return NextResponse.json(
      { error: "Invalid app config data" },
      { status: 400 }
    );
  }
}
