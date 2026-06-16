/**
 * SSO Entry URL update API
 *
 * POST — Set the SSO entry URL for an already-registered app (Control Panel bridge only).
 *
 * Apps whose SSO is configured by a post-install integration (Jellyfin, Nextcloud,
 * Immich, …) are first registered without an entry_url. Once the integration creates
 * the OAuth client, the CP calls this to set the SSO login path so the app drawer and
 * header launch the SSO flow instead of the app's local login form.
 */

import { NextResponse } from "next/server";
import { getBridgeToken } from "@/lib/admin/bridge-client";
import { setAppSsoEntryUrl } from "@/lib/db/queries/app-management";

function validateBridgeAuth(request: Request): boolean {
  const provided = request.headers.get("X-UI-Bridge-Token") ?? request.headers.get("x-ui-bridge-token");
  if (!provided) return false;
  const expected = getBridgeToken();
  return expected !== null && provided === expected;
}

export async function POST(request: Request) {
  if (!validateBridgeAuth(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { id?: string; sso_entry_url?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { id, sso_entry_url } = body;
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  await setAppSsoEntryUrl(id, sso_entry_url ?? null);

  return NextResponse.json({ success: true, app_id: id, sso_entry_url: sso_entry_url ?? null });
}
