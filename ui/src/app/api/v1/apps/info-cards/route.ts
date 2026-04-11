/**
 * Info Card Providers API
 *
 * GET — List all installed apps that provide info cards
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getInfoCardProviders } from "@/lib/db/queries/app-management";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = await getInfoCardProviders();

  return NextResponse.json({
    providers: providers.map((p) => ({
      app_id: p.appId,
      app_name: p.appName,
      cards: p.cards.map((c) => ({
        type: c.type,
        description: c.description,
        triggers: c.triggers,
      })),
    })),
  });
}
