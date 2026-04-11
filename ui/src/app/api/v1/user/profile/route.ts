/**
 * User Profile API
 *
 * GET  /api/v1/user/profile — return full user profile
 * PATCH /api/v1/user/profile — update editable profile fields
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findUserById, updateUserProfile } from "@/lib/db/queries/users";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await findUserById(session.userId);
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    userId: user.id,
    username: user.username,
    name: user.name,
    firstName: user.firstName,
    lastName: user.lastName,
    bio: user.bio,
    timezone: user.timezone,
    email: user.email,
    isAdmin: user.isAdmin,
    image: user.image,
  });
}

export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();

  // Only allow updating editable fields
  const patch: {
    firstName?: string | null;
    lastName?: string | null;
    bio?: string | null;
    timezone?: string | null;
  } = {};

  if ("firstName" in body) patch.firstName = body.firstName || null;
  if ("lastName" in body) patch.lastName = body.lastName || null;
  if ("bio" in body) patch.bio = body.bio || null;
  if ("timezone" in body) patch.timezone = body.timezone || null;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const updated = await updateUserProfile(session.userId, patch);
  if (!updated) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  return NextResponse.json({
    userId: updated.id,
    username: updated.username,
    name: updated.name,
    firstName: updated.firstName,
    lastName: updated.lastName,
    bio: updated.bio,
    timezone: updated.timezone,
    email: updated.email,
    isAdmin: updated.isAdmin,
    image: updated.image,
  });
}
