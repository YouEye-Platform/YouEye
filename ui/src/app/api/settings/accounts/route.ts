/**
 * Accounts API — aggregate view of user accounts
 *
 * GET /api/settings/accounts — returns connected accounts info
 *
 * Note: OAuth providers and connector secrets were removed in the
 * permissions-based networking migration. This endpoint now returns
 * minimal account data.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    oauthAccounts: [],
    apiKeys: [],
  });
}
