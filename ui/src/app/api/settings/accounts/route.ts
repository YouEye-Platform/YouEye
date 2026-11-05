/**
 * Accounts API — aggregate view of user accounts
 *
 * GET /api/settings/accounts — returns connected accounts info.
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
  });
}
