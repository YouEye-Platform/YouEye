/**
 * Update Flag API
 *
 * GET  — Check if a UI self-update just completed (returns flag or null).
 * POST — Set the flag before triggering UI self-update.
 * DELETE — Clear the flag after the UI has shown the completion toast.
 */

import { NextResponse } from "next/server";
import {
  getUpdateFlag,
  setUpdateFlag,
  clearUpdateFlag,
} from "@/lib/db/queries/update-flag";

export async function GET() {
  try {
    const flag = await getUpdateFlag();
    return NextResponse.json({ flag });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read flag" },
      { status: 500 }
    );
  }
}

export async function POST() {
  try {
    await setUpdateFlag();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set flag" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    await clearUpdateFlag();
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to clear flag" },
      { status: 500 }
    );
  }
}
