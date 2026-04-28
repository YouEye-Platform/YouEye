/**
 * Info Card Providers API
 *
 * GET — List all installed apps that provide info cards.
 * Includes subdomain and icon so consumers (e.g. Search) can build
 * public embed URLs and render badges.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { resolveServiceAuth } from "@/lib/auth/service";
import { getInfoCardProviders } from "@/lib/db/queries/app-management";

export async function GET(request: NextRequest) {
  const session = await getSession();
  const service = !session ? await resolveServiceAuth(request) : null;
  if (!session && !service) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = await getInfoCardProviders();

  // Service-to-service calls arrive on internal hostname (e.g. localhost:3001),
  // so use the configured external URL to derive the public base domain.
  const uiExternalUrl = process.env.UI_EXTERNAL_URL || process.env.BASE_URL || process.env.NEXTAUTH_URL || "";
  const isServiceCall = !!request.headers.get("x-youeye-app");
  let baseDomain: string;
  if (isServiceCall && uiExternalUrl) {
    try {
      baseDomain = new URL(uiExternalUrl).hostname;
    } catch {
      baseDomain = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
    }
  } else {
    baseDomain = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  }

  return NextResponse.json({
    providers: providers.map((p) => {
      const appUrl = p.subdomain
        ? `https://${p.subdomain}.${baseDomain}`
        : p.containerUrl;
      return {
        app_id: p.appId,
        app_name: p.appName,
        app_url: appUrl,
        icon: p.icon,
        cards: p.cards.map((c) => ({
          type: c.type,
          description: c.description,
          triggers: c.triggers,
          embed_path: c.embed_path ?? null,
          label: c.label ?? `Open in ${p.appName}`,
        })),
      };
    }),
  });
}
