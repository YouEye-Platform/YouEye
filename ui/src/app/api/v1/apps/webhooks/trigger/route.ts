/**
 * Webhook Trigger API
 *
 * POST — Trigger an event, notifying all subscribers
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getEventSubscribers, logInterAppRequest } from "@/lib/db/queries/inter-app";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { app_id, event, payload } = body;

  if (!app_id || !event) {
    return NextResponse.json(
      { error: "app_id and event are required" },
      { status: 400 }
    );
  }

  const subscribers = await getEventSubscribers(event);

  if (subscribers.length === 0) {
    return NextResponse.json({ delivered: 0, results: [] });
  }

  const results = await Promise.allSettled(
    subscribers.map(async (sub) => {
      try {
        const response = await fetch(sub.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event,
            source_app: app_id,
            payload: payload ?? {},
            timestamp: new Date().toISOString(),
          }),
          signal: AbortSignal.timeout(10_000),
        });

        const success = response.ok;
        await logInterAppRequest(
          session.userId,
          app_id,
          sub.subscriberAppId,
          `webhook:${event}`,
          success,
          success ? undefined : `HTTP ${response.status}`
        );

        return {
          subscriber: sub.subscriberAppId,
          success,
          status: response.status,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        await logInterAppRequest(
          session.userId,
          app_id,
          sub.subscriberAppId,
          `webhook:${event}`,
          false,
          message
        );
        return { subscriber: sub.subscriberAppId, success: false, error: message };
      }
    })
  );

  const delivered = results.filter(
    (r) => r.status === "fulfilled" && r.value.success
  ).length;

  return NextResponse.json({
    delivered,
    total: subscribers.length,
    results: results.map((r) =>
      r.status === "fulfilled" ? r.value : { success: false, error: "Promise rejected" }
    ),
  });
}
