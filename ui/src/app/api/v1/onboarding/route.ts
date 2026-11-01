/**
 * Onboarding Status API
 *
 * GET  /api/v1/onboarding — check onboarding status
 * POST /api/v1/onboarding — mark onboarding as completed
 */

import { getTimelineCollection, setTimelineCollection } from "@/lib/db/queries/timeline-collection";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { hasCompletedOnboarding } from "@/lib/db/queries/users";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const completed = await hasCompletedOnboarding(session.userId);
  return NextResponse.json({ completed, timeline: await getTimelineCollection(session.userId) });
}

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.actingAppId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const body = await request.json();
    const timeline = await setTimelineCollection(session.userId, {
      enabled: body.enabled, expected_revision: body.expected_revision, request_id: body.request_id, complete: true,
    });
    return NextResponse.json({ completed: true, timeline });
  } catch { return NextResponse.json({ error: "Choose and save your Timeline preference before completing" }, { status: 409 }); }
}
