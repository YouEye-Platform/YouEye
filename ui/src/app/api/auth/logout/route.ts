/**
 * Logout Route
 *
 * POST /api/auth/logout
 * Clears session cookies and returns success.
 */

import { NextResponse } from "next/server";
import { clearSessionCookies, getSession } from "@/lib/auth";
import { getOAuthConfig } from "@/lib/auth/oauth";

export async function POST() {
  try {
    const session = await getSession();
    if (session) {
      console.log(`User "${session.username}" logged out`);
    }

    await clearSessionCookies();
    const config = getOAuthConfig();
    const logoutUrl = config.identityUrl && config.clientId
      ? new URL(`${config.identityUrl}/application/o/${encodeURIComponent(config.clientId)}/end-session/`)
      : null;
    if (logoutUrl) {
      const uiUrl = process.env.UI_EXTERNAL_URL;
      if (uiUrl) logoutUrl.searchParams.set('post_logout_redirect_uri', `${uiUrl}/`);
    }
    return NextResponse.json({ success: true, logoutUrl: logoutUrl?.toString() || null });
  } catch (error) {
    console.error("Logout error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
