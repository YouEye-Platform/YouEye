import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { getProfileIconPreset } from "@/lib/profile-icon-presets";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const preset = getProfileIconPreset(id);
  if (!preset) {
    return NextResponse.json({ error: "Unknown profile icon" }, { status: 404 });
  }

  const artwork = await readFile(
    join(process.cwd(), "public", "profile-avatar-art", `${preset.id}.png`)
  );
  return new NextResponse(artwork, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
