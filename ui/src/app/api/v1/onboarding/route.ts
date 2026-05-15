/**
 * Onboarding Status API
 *
 * GET  /api/v1/onboarding — check onboarding status
 * POST /api/v1/onboarding — mark onboarding as completed
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasCompletedOnboarding, completeOnboarding } from "@/lib/db/queries/users";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const completed = await hasCompletedOnboarding(session.userId);
  return NextResponse.json({ completed });
}

export async function POST() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await completeOnboarding(session.userId);
  return NextResponse.json({ completed: true });
}
