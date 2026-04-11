/**
 * Inter-App Request API
 *
 * POST — Route a data request from one app to another
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { routeInterAppRequest } from "@/lib/db/queries/inter-app";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { from_app, to_app, request_type, data } = body;

  if (!from_app || !to_app || !request_type) {
    return NextResponse.json(
      { error: "from_app, to_app, and request_type are required" },
      { status: 400 }
    );
  }

  const result = await routeInterAppRequest(
    session.userId,
    from_app,
    to_app,
    request_type,
    data ?? {}
  );

  if (!result.success) {
    const status = result.error?.code === "PERMISSION_DENIED" ? 403 : 502;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
