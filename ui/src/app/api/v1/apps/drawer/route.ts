/**
 * App Drawer API
 *
 * GET /api/apps/drawer — Get user's customized app drawer
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getUserAppsWithConfig } from "@/lib/db/queries/apps";

function buildAppUrl(
  subdomain: string | null,
  containerUrl: string | null,
  appId: string,
  host: string,
  ssoEntryUrl: string | null
): string {
  if (!subdomain) return containerUrl ?? `/app/${appId}`;
  // Derive protocol + base domain from the request host
  const baseDomain = host.replace(/:\d+$/, "");
  const baseUrl = `https://${subdomain}.${baseDomain}`;
  return ssoEntryUrl ? `${baseUrl}${ssoEntryUrl}` : baseUrl;
}

export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const host = request.headers.get("host") ?? "";
  const data = await getUserAppsWithConfig(session.userId);

  return NextResponse.json({
    apps: data.apps.map((a) => ({
      id: a.id,
      name: a.customName ?? a.name,
      original_name: a.name,
      icon: a.icon,
      custom_icon_url: a.customIconUrl,
      visible: a.visible,
      order: a.displayOrder,
      section_id: a.sectionId,
      status: a.status,
      version: a.version ?? null,
      subdomain: a.subdomain ?? null,
      containerUrl: a.containerUrl ?? null,
      hasSettingsPanel: !!(a.manifest as any)?.capabilities?.settings_panel,
      url: buildAppUrl(a.subdomain, a.containerUrl, a.id, host, a.ssoEntryUrl),
    })),
    sections: data.sections.map((s) => ({
      id: s.sectionId,
      name: s.name,
      order: s.displayOrder,
      collapsed: s.collapsed,
    })),
  });
}
