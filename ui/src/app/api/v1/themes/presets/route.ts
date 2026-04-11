/**
 * Preset Themes API
 *
 * GET /api/themes/presets — List only preset (built-in) themes
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { listPresetThemes } from "@/lib/db/queries/themes";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const presets = await listPresetThemes();
    return NextResponse.json(presets);
  } catch (error) {
    console.error("[themes] Failed to list presets:", error);
    return NextResponse.json(
      { error: "Failed to load preset themes" },
      { status: 500 }
    );
  }
}
