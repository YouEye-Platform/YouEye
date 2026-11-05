import { NextRequest, NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import {
  getServerPresets,
  createPreset,
  deletePreset,
  renamePreset,
} from "@/lib/db/queries/wordart-presets";

function validateToken(request: NextRequest): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function GET(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const presets = await getServerPresets();
  return NextResponse.json({ presets });
}

export async function POST(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body.name || !body.style) {
      return NextResponse.json({ error: "name and style required" }, { status: 400 });
    }
    const preset = await createPreset(
      body.admin_user_id || null,
      body.name,
      body.style,
      "server"
    );
    return NextResponse.json({ preset }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const ok = await deletePreset(body.id, body.admin_user_id || "", true);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!validateToken(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await request.json();
    if (!body.id || !body.name) {
      return NextResponse.json({ error: "id and name required" }, { status: 400 });
    }
    const preset = await renamePreset(body.id, body.admin_user_id || "", body.name, true);
    if (!preset) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ preset });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
