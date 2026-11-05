/**
 * User Per-App WordArt Presets API
 *
 * GET    — list user + server presets for this app
 * POST   — save current style as a preset for this app
 * DELETE — delete a preset
 * PATCH  — rename a preset
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  getAppPresetsForUser,
  createPreset,
  deletePreset,
  renamePreset,
} from "@/lib/db/queries/wordart-presets";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { appId } = await params;
  const presets = await getAppPresetsForUser(session.userId, appId);
  return NextResponse.json({ presets });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { appId } = await params;
  try {
    const body = await request.json();
    if (!body.name || !body.style) {
      return NextResponse.json({ error: "name and style required" }, { status: 400 });
    }
    const preset = await createPreset(session.userId, body.name, body.style, "user", appId);
    return NextResponse.json({ preset }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await params;
  try {
    const body = await request.json();
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const ok = await deletePreset(body.id, session.userId);
    if (!ok) return NextResponse.json({ error: "Not found or forbidden" }, { status: 404 });
    return NextResponse.json({ deleted: true });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appId: string }> }
) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await params;
  try {
    const body = await request.json();
    if (!body.id || !body.name) {
      return NextResponse.json({ error: "id and name required" }, { status: 400 });
    }
    const preset = await renamePreset(body.id, session.userId, body.name);
    if (!preset) return NextResponse.json({ error: "Not found or forbidden" }, { status: 404 });
    return NextResponse.json({ preset });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
