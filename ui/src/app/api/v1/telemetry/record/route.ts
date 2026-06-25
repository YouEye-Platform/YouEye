/**
 * Telemetry Record Endpoint
 *
 * Receives batched usage events from the client-side telemetry provider.
 * No personal data is stored — only route paths, feature IDs, and counters.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { trackRoute, trackFeature, trackAppLaunch, trackError } from "@/lib/telemetry/tracker";

interface TelemetryEvent {
  type: "route" | "feature" | "app_launch" | "error";
  key: string;
  message?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const events: TelemetryEvent[] = Array.isArray(body.events) ? body.events : [];

    // Process up to 50 events per batch to prevent abuse
    const batch = events.slice(0, 50);

    for (const event of batch) {
      if (!event.type || !event.key) continue;

      switch (event.type) {
        case "route":
          trackRoute(event.key);
          break;
        case "feature":
          trackFeature(event.key);
          break;
        case "app_launch":
          trackAppLaunch(event.key);
          break;
        case "error":
          trackError(event.key, event.message || "Unknown error");
          break;
      }
    }

    return NextResponse.json({ ok: true, recorded: batch.length });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
