/**
 * Webhook Registration API
 *
 * POST — Register a webhook subscription for an app event
 * GET  — List webhook subscriptions for an app
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { registerWebhook, removeWebhook } from "@/lib/db/queries/inter-app";
import { db } from "@/db";
import { webhookSubscriptions } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function POST(request: Request) {
  const session = await getSession();
  if (!session || !session.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const body = await request.json();
  const { app_id, event, endpoint } = body;

  if (!app_id || !event || !endpoint) {
    return NextResponse.json(
      { error: "app_id, event, and endpoint are required" },
      { status: 400 }
    );
  }

  const sub = await registerWebhook(app_id, event, endpoint);
  return NextResponse.json({ webhook: sub }, { status: 201 });
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session || !session.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const appId = searchParams.get("app_id");

  if (!appId) {
    return NextResponse.json(
      { error: "app_id query parameter required" },
      { status: 400 }
    );
  }

  const subs = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.subscriberAppId, appId));

  return NextResponse.json({ webhooks: subs });
}

export async function DELETE(request: Request) {
  const session = await getSession();
  if (!session || !session.isAdmin) {
    return NextResponse.json({ error: "Admin required" }, { status: 403 });
  }

  const body = await request.json();
  const { webhook_id } = body;

  if (!webhook_id) {
    return NextResponse.json(
      { error: "webhook_id is required" },
      { status: 400 }
    );
  }

  await removeWebhook(webhook_id);
  return NextResponse.json({ success: true });
}
