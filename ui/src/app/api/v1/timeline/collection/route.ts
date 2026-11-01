import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { checkPermission } from "@/lib/db/queries/permissions";
import { getTimelineCollection, setTimelineCollection, TimelineCollectionError } from "@/lib/db/queries/timeline-collection";

export async function GET(request: NextRequest) {
  const service = await resolveServiceAuth(request);
  const session = service ? null : await getSession();
  if (!service && !session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (service && !await checkPermission(service.id, service.appId, "timeline:write")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await getTimelineCollection(service?.id ?? session!.userId), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Timeline collection state is unknown" }, { status: 503 });
  }
}
export async function PUT(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.actingAppId) return NextResponse.json({ error: "Use your personal privacy settings" }, { status: 403 });
  try {
    const body = await request.json();
    return NextResponse.json(await setTimelineCollection(session.userId, body));
  } catch (error) {
    if (error instanceof TimelineCollectionError) return NextResponse.json({ error: error.code }, { status: 409 });
    return NextResponse.json({ error: "Collection preference was not saved" }, { status: 400 });
  }
}
