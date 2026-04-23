/**
 * OAuth Provider Disconnect
 *
 * POST /api/auth/providers/[slug]/disconnect
 * Removes the user's stored OAuth token for this provider.
 */

import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getProvider, deleteUserToken } from "@/lib/db/queries/auth-providers";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { slug } = await params;
  const provider = await getProvider(slug);
  if (!provider) {
    return NextResponse.json({ error: "Provider not found" }, { status: 404 });
  }

  await deleteUserToken(session.userId, provider.id);

  return NextResponse.json({ ok: true });
}
